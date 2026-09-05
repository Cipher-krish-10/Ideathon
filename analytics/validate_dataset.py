#!/usr/bin/env python3
"""
RevenuePilot — synthetic dataset validator.

Independently re-derives everything the generator claims, from the emitted files
only. It does not import the generator; if the two disagree, that is the point.

Exit code 0 = all checks passed, 1 = at least one failure.

Usage:
    python3 analytics/validate_dataset.py
    python3 analytics/validate_dataset.py --data data --strict
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

# Demo-viability floors. If the dataset drops below these, the demo is not viable
# and the build should fail rather than discover it on stage.
MIN_QUALIFYING_OPPORTUNITIES = 15
MIN_RECOVERABLE_PAISE = 10_000_000        # Rs 1,00,000
MIN_HIGH_TIER_OPPORTUNITIES = 5
MIN_NON_OPPORTUNITY_CASES = 3             # per exclusion category


class Validator:
    def __init__(self, data_dir: Path, strict: bool = False):
        self.dir = data_dir
        self.strict = strict
        self.failures: list[str] = []
        self.warnings: list[str] = []
        self.checks_run = 0

        self.customers = self._read_csv("customers.csv")
        self.products = self._read_csv("products.csv")
        self.transactions = self._read_csv("transactions.csv")
        self.attempts = self._read_csv("payment_attempts.csv")
        self.config = self._read_json("merchant_config.json")
        self.summary = self._read_json("dataset_summary.json")
        self.manifest = self._read_json("scenario_manifest.json")

        dcfg = self.config["detector_config"]
        self.recoverable_reasons = set(dcfg["recoverable_failure_reasons"])
        self.non_recoverable_reasons = set(dcfg["non_recoverable_failure_reasons"])
        self.all_reasons = self.recoverable_reasons | self.non_recoverable_reasons
        self.recency_days = dcfg["recency_window_days"]
        self.min_amount = dcfg["min_transaction_amount_paise"]
        self.min_ltv = dcfg["min_customer_lifetime_value_paise"]
        self.reference_dt = datetime.fromisoformat(
            self.config["dataset"]["reference_datetime"]
        )

        self.customers_by_id = {c["customer_id"]: c for c in self.customers}
        self.products_by_id = {p["product_id"]: p for p in self.products}
        self.txns_by_id = {t["transaction_id"]: t for t in self.transactions}
        self.attempts_by_id = {a["attempt_id"]: a for a in self.attempts}
        self.chain_by_txn: dict[str, list[dict]] = defaultdict(list)
        for a in self.attempts:
            self.chain_by_txn[a["transaction_id"]].append(a)
        for txn_id in self.chain_by_txn:
            self.chain_by_txn[txn_id].sort(key=lambda a: int(a["attempt_no"]))

    # -- io -----------------------------------------------------------------

    def _read_csv(self, name: str) -> list[dict]:
        with (self.dir / name).open(encoding="utf-8") as fh:
            return list(csv.DictReader(fh))

    def _read_json(self, name: str) -> dict:
        with (self.dir / name).open(encoding="utf-8") as fh:
            return json.load(fh)

    # -- assertions ---------------------------------------------------------

    def check(self, label: str, condition: bool, detail: str = "") -> bool:
        self.checks_run += 1
        if not condition:
            self.failures.append(f"{label}{': ' + detail if detail else ''}")
        return condition

    def warn(self, label: str, condition: bool, detail: str = "") -> None:
        self.checks_run += 1
        if not condition:
            self.warnings.append(f"{label}{': ' + detail if detail else ''}")

    # -- helpers ------------------------------------------------------------

    @staticmethod
    def is_positive_int(value: str) -> bool:
        try:
            return int(value) > 0 and str(int(value)) == value.strip()
        except (ValueError, AttributeError):
            return False

    @staticmethod
    def parse_dt(value: str):
        try:
            return datetime.fromisoformat(value)
        except (ValueError, TypeError):
            return None

    # -- checks -------------------------------------------------------------

    def check_unique_ids(self) -> None:
        for label, rows, key in [
            ("customers", self.customers, "customer_id"),
            ("products", self.products, "product_id"),
            ("transactions", self.transactions, "transaction_id"),
            ("payment_attempts", self.attempts, "attempt_id"),
        ]:
            ids = [r[key] for r in rows]
            dupes = [k for k, n in Counter(ids).items() if n > 1]
            self.check(f"unique ids: {label}", not dupes, f"{len(dupes)} duplicates")
            self.check(f"non-empty ids: {label}", all(ids), "blank id present")

    def check_foreign_keys(self) -> None:
        bad = [t["transaction_id"] for t in self.transactions
               if t["customer_id"] not in self.customers_by_id]
        self.check("fk: transaction.customer_id", not bad, f"{len(bad)} unresolved")

        bad = [t["transaction_id"] for t in self.transactions
               if t["product_id"] not in self.products_by_id]
        self.check("fk: transaction.product_id", not bad, f"{len(bad)} unresolved")

        bad = [a["attempt_id"] for a in self.attempts
               if a["transaction_id"] not in self.txns_by_id]
        self.check("fk: attempt.transaction_id", not bad, f"{len(bad)} unresolved")

        bad = [a["attempt_id"] for a in self.attempts
               if a["customer_id"] not in self.customers_by_id]
        self.check("fk: attempt.customer_id", not bad, f"{len(bad)} unresolved")

        bad = [a["attempt_id"] for a in self.attempts
               if a["retry_of_attempt_id"] and a["retry_of_attempt_id"] not in self.attempts_by_id]
        self.check("fk: attempt.retry_of_attempt_id", not bad, f"{len(bad)} unresolved")

        # An attempt's customer must match its transaction's customer.
        bad = [a["attempt_id"] for a in self.attempts
               if a["transaction_id"] in self.txns_by_id
               and a["customer_id"] != self.txns_by_id[a["transaction_id"]]["customer_id"]]
        self.check("fk: attempt/transaction customer agreement", not bad, f"{len(bad)} mismatched")

    def check_amounts(self) -> None:
        bad = [p["product_id"] for p in self.products if not self.is_positive_int(p["price_paise"])]
        self.check("amounts: product.price_paise positive integer", not bad, f"{len(bad)} bad")

        bad = [t["transaction_id"] for t in self.transactions
               if not self.is_positive_int(t["amount_paise"])]
        self.check("amounts: transaction.amount_paise positive integer", not bad, f"{len(bad)} bad")

        bad = [a["attempt_id"] for a in self.attempts
               if not self.is_positive_int(a["amount_paise"])]
        self.check("amounts: attempt.amount_paise positive integer", not bad, f"{len(bad)} bad")

        bad = [c["customer_id"] for c in self.customers
               if int(c["lifetime_value_paise"]) < 0 or int(c["historical_value_paise"]) < 0]
        self.check("amounts: customer values non-negative", not bad, f"{len(bad)} bad")

        # amount must equal unit price x quantity
        bad = []
        for t in self.transactions:
            product = self.products_by_id.get(t["product_id"])
            if not product:
                continue
            expected = int(product["price_paise"]) * int(t["quantity"])
            if expected != int(t["amount_paise"]):
                bad.append(t["transaction_id"])
        self.check("amounts: transaction = price x quantity", not bad, f"{len(bad)} mismatched")

        # every attempt bills the transaction's amount
        bad = [a["attempt_id"] for a in self.attempts
               if a["transaction_id"] in self.txns_by_id
               and int(a["amount_paise"]) != int(self.txns_by_id[a["transaction_id"]]["amount_paise"])]
        self.check("amounts: attempt matches transaction amount", not bad, f"{len(bad)} mismatched")

        bad = [r["transaction_id"] for r in self.transactions if r["currency"] != "INR"]
        self.check("amounts: currency is INR throughout", not bad, f"{len(bad)} bad")

    def check_timestamps(self) -> None:
        window_start = self.parse_dt(self.config["dataset"]["window_start_date"] + "T00:00:00+05:30")
        hard_floor = window_start - timedelta(days=1000)

        bad = [t["transaction_id"] for t in self.transactions
               if self.parse_dt(t["created_at"]) is None]
        self.check("timestamps: transaction.created_at parseable", not bad, f"{len(bad)} bad")

        bad = [a["attempt_id"] for a in self.attempts if self.parse_dt(a["created_at"]) is None]
        self.check("timestamps: attempt.created_at parseable", not bad, f"{len(bad)} bad")

        bad = [c["customer_id"] for c in self.customers
               if self.parse_dt(c["signup_at"]) is None]
        self.check("timestamps: customer.signup_at parseable", not bad, f"{len(bad)} bad")

        # Nothing may originate after the dataset's reference instant.
        late = [t["transaction_id"] for t in self.transactions
                if (dt := self.parse_dt(t["created_at"])) and dt > self.reference_dt]
        self.check("timestamps: no transaction after reference date", not late, f"{len(late)} in future")

        early = [t["transaction_id"] for t in self.transactions
                 if (dt := self.parse_dt(t["created_at"])) and dt < hard_floor]
        self.check("timestamps: no absurdly old transaction", not early, f"{len(early)} too old")

        # Customers must exist before they transact.
        bad = []
        for t in self.transactions:
            cust = self.customers_by_id.get(t["customer_id"])
            if not cust:
                continue
            signup = self.parse_dt(cust["signup_at"])
            created = self.parse_dt(t["created_at"])
            if signup and created and created < signup:
                bad.append(t["transaction_id"])
        self.check("timestamps: transaction after customer signup", not bad, f"{len(bad)} precede signup")

        # Refunds must follow settlement.
        bad = []
        for t in self.transactions:
            if not t["refunded_at"]:
                continue
            refunded = self.parse_dt(t["refunded_at"])
            updated = self.parse_dt(t["updated_at"])
            if not refunded or (updated and refunded < updated):
                bad.append(t["transaction_id"])
        self.check("timestamps: refund after settlement", not bad, f"{len(bad)} bad")

    def check_failure_reasons(self) -> None:
        bad = [a["attempt_id"] for a in self.attempts
               if a["status"] == "FAILED" and not a["failure_reason"]]
        self.check("reasons: every FAILED attempt has a reason", not bad, f"{len(bad)} missing")

        bad = [a["attempt_id"] for a in self.attempts
               if a["status"] == "SUCCESS" and a["failure_reason"]]
        self.check("reasons: no SUCCESS attempt carries a reason", not bad, f"{len(bad)} unexpected")

        bad = [a["attempt_id"] for a in self.attempts
               if a["failure_reason"] and a["failure_reason"] not in self.all_reasons]
        self.check("reasons: all values are known categories", not bad, f"{len(bad)} unknown")

        bad = [a["attempt_id"] for a in self.attempts
               if a["status"] not in ("SUCCESS", "FAILED")]
        self.check("reasons: attempt status in {SUCCESS, FAILED}", not bad, f"{len(bad)} bad")

        present = {a["failure_reason"] for a in self.attempts if a["failure_reason"]}
        missing = sorted(self.all_reasons - present)
        self.check("reasons: every declared category appears", not missing, f"absent: {missing}")

    def check_suppression(self) -> None:
        active, expired = [], []
        for c in self.customers:
            raw = c["do_not_contact_until"]
            if not raw:
                continue
            dt = self.parse_dt(raw)
            if not self.check(f"suppression: parseable date for {c['customer_id']}", dt is not None):
                continue
            (active if dt > self.reference_dt else expired).append(c["customer_id"])

        self.check("suppression: at least 3 actively suppressed customers",
                   len(active) >= 3, f"found {len(active)}")
        self.check("suppression: at least 1 expired suppression (tests date comparison)",
                   len(expired) >= 1, f"found {len(expired)}")

        bad = [c["customer_id"] for c in self.customers
               if c["suppression_reason"] and not c["do_not_contact_until"]]
        self.check("suppression: reason implies a date", not bad, f"{len(bad)} orphaned reasons")

        bad = [c["customer_id"] for c in self.customers
               if c["do_not_contact_until"] and not c["suppression_reason"]]
        self.check("suppression: date implies a reason", not bad, f"{len(bad)} missing reasons")

        self.active_suppressed = set(active)
        self.expired_suppressed = set(expired)

    def check_attempt_chains(self) -> None:
        bad_numbering, bad_retry_link, bad_order, bad_multi_success, bad_success_pos = [], [], [], [], []
        bad_count, bad_status = [], []

        for txn_id, chain in sorted(self.chain_by_txn.items()):
            nums = [int(a["attempt_no"]) for a in chain]
            if nums != list(range(1, len(chain) + 1)):
                bad_numbering.append(txn_id)

            for idx, a in enumerate(chain):
                expected_parent = "" if idx == 0 else chain[idx - 1]["attempt_id"]
                if a["retry_of_attempt_id"] != expected_parent:
                    bad_retry_link.append(a["attempt_id"])

            times = [self.parse_dt(a["created_at"]) for a in chain]
            if any(t is None for t in times) or times != sorted(times):
                bad_order.append(txn_id)

            successes = [a for a in chain if a["status"] == "SUCCESS"]
            if len(successes) > 1:
                bad_multi_success.append(txn_id)
            if successes and successes[0]["attempt_id"] != chain[-1]["attempt_id"]:
                bad_success_pos.append(txn_id)

            txn = self.txns_by_id.get(txn_id)
            if txn:
                if int(txn["attempt_count"]) != len(chain):
                    bad_count.append(txn_id)
                expected_status = "CAPTURED" if successes else "FAILED"
                actual = txn["status"]
                if actual == "REFUNDED":
                    if not successes:
                        bad_status.append(txn_id)
                elif actual != expected_status:
                    bad_status.append(txn_id)

        self.check("chains: attempt_no is 1..n contiguous", not bad_numbering, f"{len(bad_numbering)} bad")
        self.check("chains: retry_of points to the previous attempt", not bad_retry_link,
                   f"{len(bad_retry_link)} bad")
        self.check("chains: attempts are chronological", not bad_order, f"{len(bad_order)} bad")
        self.check("chains: at most one SUCCESS per transaction", not bad_multi_success,
                   f"{len(bad_multi_success)} bad")
        self.check("chains: SUCCESS is always the terminal attempt", not bad_success_pos,
                   f"{len(bad_success_pos)} bad")
        self.check("chains: transaction.attempt_count matches chain length", not bad_count,
                   f"{len(bad_count)} bad")
        self.check("chains: transaction.status agrees with its chain", not bad_status,
                   f"{len(bad_status)} bad")

        orphan_txns = [t["transaction_id"] for t in self.transactions
                       if t["transaction_id"] not in self.chain_by_txn]
        self.check("chains: every transaction has at least one attempt", not orphan_txns,
                   f"{len(orphan_txns)} orphaned")

        bad = [t["transaction_id"] for t in self.transactions
               if t["refunded_at"] and t["status"] != "REFUNDED"]
        self.check("chains: refunded_at only on REFUNDED transactions", not bad, f"{len(bad)} bad")

        bad = [t["transaction_id"] for t in self.transactions
               if t["status"] == "REFUNDED" and not t["refunded_at"]]
        self.check("chains: REFUNDED transactions carry refunded_at", not bad, f"{len(bad)} bad")

        bad = [t["transaction_id"] for t in self.transactions
               if t["status"] not in ("CAPTURED", "FAILED", "REFUNDED")]
        self.check("chains: transaction status in known set", not bad, f"{len(bad)} bad")

    def check_customer_value_consistency(self) -> None:
        captured = defaultdict(int)
        for t in self.transactions:
            if t["status"] == "CAPTURED":
                captured[t["customer_id"]] += int(t["amount_paise"])

        bad_ltv, bad_tier, bad_hist = [], [], []
        tiers = self.config["customer_tiers"]
        for c in self.customers:
            ltv = int(c["lifetime_value_paise"])
            hist = int(c["historical_value_paise"])
            in_window = captured.get(c["customer_id"], 0)

            if ltv < in_window:
                bad_ltv.append(c["customer_id"])
            if hist + in_window != ltv:
                bad_hist.append(c["customer_id"])

            if ltv >= tiers["HIGH"]["min_lifetime_value_paise"]:
                expected = "HIGH"
            elif ltv >= tiers["MEDIUM"]["min_lifetime_value_paise"]:
                expected = "MEDIUM"
            else:
                expected = "LOW"
            if c["tier"] != expected:
                bad_tier.append(c["customer_id"])

        self.check("value: lifetime_value >= in-window captured", not bad_ltv, f"{len(bad_ltv)} bad")
        self.check("value: historical + in-window == lifetime_value", not bad_hist, f"{len(bad_hist)} bad")
        self.check("value: tier matches lifetime_value thresholds", not bad_tier, f"{len(bad_tier)} bad")

        tier_counts = Counter(c["tier"] for c in self.customers)
        for tier in ("HIGH", "MEDIUM", "LOW"):
            self.check(f"value: {tier} tier is populated", tier_counts[tier] > 0,
                       f"count={tier_counts[tier]}")

    # -- the detector predicate, re-implemented independently ---------------

    def derive_opportunities(self) -> tuple[list[dict], dict[str, str]]:
        """Returns (qualifying targets, {txn_id: exclusion_reason})."""
        cutoff = self.reference_dt - timedelta(days=self.recency_days)
        qualifying: list[dict] = []
        excluded: dict[str, str] = {}

        for txn_id in sorted(self.chain_by_txn):
            chain = self.chain_by_txn[txn_id]
            if any(a["status"] == "SUCCESS" for a in chain):
                excluded[txn_id] = "ALREADY_RECOVERED"
                continue
            failed = [a for a in chain if a["status"] == "FAILED"]
            if not failed:
                excluded[txn_id] = "NO_FAILED_ATTEMPT"
                continue
            latest = failed[-1]
            if latest["failure_reason"] not in self.recoverable_reasons:
                excluded[txn_id] = "NON_RECOVERABLE_REASON"
                continue
            if self.parse_dt(latest["created_at"]) < cutoff:
                excluded[txn_id] = "STALE"
                continue
            txn = self.txns_by_id[txn_id]
            if int(txn["amount_paise"]) < self.min_amount:
                excluded[txn_id] = "BELOW_TICKET_FLOOR"
                continue
            cust = self.customers_by_id[txn["customer_id"]]
            if int(cust["lifetime_value_paise"]) < self.min_ltv:
                excluded[txn_id] = "BELOW_LTV_FLOOR"
                continue
            dnc = cust["do_not_contact_until"]
            if dnc and self.parse_dt(dnc) > self.reference_dt:
                excluded[txn_id] = "SUPPRESSED"
                continue
            qualifying.append({
                "transaction_id": txn_id,
                "customer_id": cust["customer_id"],
                "amount_paise": int(txn["amount_paise"]),
                "failure_reason": latest["failure_reason"],
                "tier": cust["tier"],
                "failed_attempts": len(failed),
            })

        self.qualifying = qualifying
        self.excluded = excluded
        return qualifying, excluded

    def check_demo_viability(self) -> None:
        qualifying, excluded = self.derive_opportunities()
        total = sum(q["amount_paise"] for q in qualifying)

        self.check("demo: enough qualifying opportunities",
                   len(qualifying) >= MIN_QUALIFYING_OPPORTUNITIES,
                   f"{len(qualifying)} < {MIN_QUALIFYING_OPPORTUNITIES}")
        self.check("demo: recoverable value is material",
                   total >= MIN_RECOVERABLE_PAISE,
                   f"{total} paise < {MIN_RECOVERABLE_PAISE}")

        high = sum(1 for q in qualifying if q["tier"] == "HIGH")
        self.check("demo: HIGH-tier opportunities present",
                   high >= MIN_HIGH_TIER_OPPORTUNITIES, f"{high} < {MIN_HIGH_TIER_OPPORTUNITIES}")

        multi = sum(1 for q in qualifying if q["failed_attempts"] > 1)
        self.check("demo: repeated-failure opportunities present", multi >= 3, f"{multi} < 3")

        reasons = {q["failure_reason"] for q in qualifying}
        self.check("demo: opportunities span multiple failure reasons",
                   len(reasons) >= 3, f"only {len(reasons)}")

        # The detector must have to discriminate, not just count failures.
        exclusion_counts = Counter(excluded.values())
        for category in ("ALREADY_RECOVERED", "NON_RECOVERABLE_REASON", "STALE",
                         "BELOW_TICKET_FLOOR", "BELOW_LTV_FLOOR", "SUPPRESSED"):
            self.check(f"demo: non-opportunities present ({category})",
                       exclusion_counts[category] >= MIN_NON_OPPORTUNITY_CASES,
                       f"{exclusion_counts[category]} < {MIN_NON_OPPORTUNITY_CASES}")

        self.exclusion_counts = exclusion_counts

    def check_planted_cohorts(self) -> None:
        """Cross-check the derived view against the planted scenario manifest.

        The manifest is a test fixture. It never reaches the application.
        """
        cohorts = self.manifest["cohorts"]
        qualifying_ids = {q["transaction_id"] for q in self.qualifying}

        must_qualify = {
            "_txn_A_HIGH_VALUE_RECOVERABLE": "A high-value recoverable",
            "_txn_D_REPEATED_FAILURE": "D repeated failure",
            "_txn_F_HIGH_VALUE_OPPORTUNITY": "F high-value opportunity",
        }
        for key, label in must_qualify.items():
            txns = cohorts.get(key, [])
            missed = [t for t in txns if t not in qualifying_ids]
            self.check(f"cohort: {label} fully detected",
                       not missed and len(txns) > 0,
                       f"{len(missed)}/{len(txns)} missed")

        must_not_qualify = {
            "_txn_B1_NON_RECOVERABLE_REASON": ("B1 non-recoverable reason", "NON_RECOVERABLE_REASON"),
            "_txn_B2_SUPPRESSED_CUSTOMER": ("B2 suppressed customer", "SUPPRESSED"),
            "_txn_C_ALREADY_RECOVERED": ("C already recovered", "ALREADY_RECOVERED"),
            "_txn_E_LOW_VALUE_FAILURE": ("E low value", None),
            "_txn_G_STALE_FAILURE": ("G stale failure", "STALE"),
        }
        for key, (label, expected_reason) in must_not_qualify.items():
            txns = cohorts.get(key, [])
            leaked = [t for t in txns if t in qualifying_ids]
            self.check(f"cohort: {label} correctly excluded",
                       not leaked and len(txns) > 0, f"{len(leaked)}/{len(txns)} leaked")
            if expected_reason:
                wrong = [t for t in txns if self.excluded.get(t) != expected_reason]
                self.check(f"cohort: {label} excluded for the right reason",
                           not wrong,
                           f"{len(wrong)} excluded via "
                           f"{sorted({self.excluded.get(t) for t in wrong})}")

    def check_summary_agreement(self) -> None:
        """The published summary must match what we just derived independently."""
        rc = self.summary["row_counts"]
        self.check("summary: customer count", rc["customers"] == len(self.customers))
        self.check("summary: product count", rc["products"] == len(self.products))
        self.check("summary: transaction count", rc["transactions"] == len(self.transactions))
        self.check("summary: attempt count", rc["payment_attempts"] == len(self.attempts))

        failed_attempts = sum(1 for a in self.attempts if a["status"] == "FAILED")
        self.check("summary: failed attempt count",
                   rc["failed_payment_attempts"] == failed_attempts)

        captured = sum(int(t["amount_paise"]) for t in self.transactions
                       if t["status"] == "CAPTURED")
        self.check("summary: captured revenue",
                   self.summary["money_paise"]["captured_revenue"] == captured)

        view = self.summary["derived_opportunity_view"]
        self.check("summary: qualifying opportunity count matches independent derivation",
                   view["qualifying_transactions"] == len(self.qualifying),
                   f"summary={view['qualifying_transactions']} derived={len(self.qualifying)}")
        self.check("summary: recoverable amount matches independent derivation",
                   view["recoverable_amount_paise"] == sum(q["amount_paise"] for q in self.qualifying))

        self.check("summary: scale target 500 customers",
                   len(self.customers) == 500, f"{len(self.customers)}")
        self.check("summary: transaction count within 500-1500",
                   500 <= len(self.transactions) <= 1500, f"{len(self.transactions)}")
        self.check("summary: failed attempts within 60-100",
                   60 <= failed_attempts <= 100, f"{failed_attempts}")

    def check_no_label_leakage(self) -> None:
        """No emitted application-facing file may carry a conclusion column."""
        banned = {"recoverable", "is_recoverable", "should_target", "is_opportunity",
                  "expected_recovery", "opportunity", "label", "target"}
        for name, rows in [("customers.csv", self.customers), ("products.csv", self.products),
                           ("transactions.csv", self.transactions),
                           ("payment_attempts.csv", self.attempts)]:
            if not rows:
                continue
            cols = {c.strip().lower() for c in rows[0].keys()}
            leaked = sorted(cols & banned)
            self.check(f"no-leak: {name} carries evidence only", not leaked, f"found {leaked}")

    # -- run ----------------------------------------------------------------

    def run(self) -> bool:
        self.check_unique_ids()
        self.check_foreign_keys()
        self.check_amounts()
        self.check_timestamps()
        self.check_failure_reasons()
        self.check_suppression()
        self.check_attempt_chains()
        self.check_customer_value_consistency()
        self.check_demo_viability()
        self.check_planted_cohorts()
        self.check_summary_agreement()
        self.check_no_label_leakage()

        print(f"checks run: {self.checks_run}")
        if self.warnings:
            print(f"warnings: {len(self.warnings)}")
            for w in self.warnings:
                print(f"  ~ {w}")
        if self.failures:
            print(f"FAILED: {len(self.failures)}")
            for f in self.failures:
                print(f"  x {f}")
            return False
        print("all checks passed")
        return True

    def report(self) -> None:
        total = sum(q["amount_paise"] for q in self.qualifying)
        print("\n-- derived opportunity view (from emitted files only) --")
        print(f"  qualifying transactions : {len(self.qualifying)}")
        print(f"  distinct customers      : {len({q['customer_id'] for q in self.qualifying})}")
        print(f"  recoverable value       : Rs {total / 100:,.2f}")
        by_tier = Counter(q["tier"] for q in self.qualifying)
        print(f"  by tier                 : "
              + ", ".join(f"{k}={by_tier[k]}" for k in sorted(by_tier)))
        print("\n-- why the rest were excluded --")
        for reason, n in sorted(self.exclusion_counts.items(), key=lambda kv: (-kv[1], kv[0])):
            print(f"  {reason:<24} {n}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate the RevenuePilot synthetic dataset.")
    parser.add_argument("--data", type=str, default="data")
    parser.add_argument("--strict", action="store_true", help="treat warnings as failures")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    v = Validator(Path(args.data), strict=args.strict)
    ok = v.run()
    if not args.quiet:
        v.report()
    if args.strict and v.warnings:
        ok = False
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
