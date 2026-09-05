#!/usr/bin/env python3
"""
RevenuePilot — synthetic merchant dataset generator.

Produces a controlled, fully deterministic simulated merchant environment for the
failed-payment-recovery MVP.

DESIGN RULE (non-negotiable):
    This generator emits EVIDENCE, never CONCLUSIONS.
    No row carries `recoverable`, `should_target`, or any equivalent label.
    Whether a failed payment is a revenue opportunity is DERIVED at runtime by the
    deterministic detector, from:
        - the attempt's failure_reason        (classified via merchant_config)
        - the absence of a later SUCCESS attempt on the same transaction
        - the age of the failure vs. the recency window
        - the customer's do_not_contact_until state
        - value floors on transaction amount and customer lifetime value

MONEY RULE:
    Every monetary field emitted is an INTEGER number of paise.
    Rupee-scale values are used only as internal generator parameters.

DETERMINISM RULE:
    Same --seed + same --end-date => byte-identical output files.
    No wall-clock reads, no unordered iteration, no hash-seed dependence.

Stdlib only, by design: zero install friction and no third-party RNG drift.

Usage:
    python3 analytics/generate_dataset.py
    python3 analytics/generate_dataset.py --seed 20260905 --end-date 2026-09-01 --out data
"""

from __future__ import annotations

import argparse
import csv
import json
import random
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

IST = timezone(timedelta(hours=5, minutes=30))
CURRENCY = "INR"

DEFAULT_SEED = 20260905
DEFAULT_END_DATE = "2026-09-01"      # dataset reference date ("as of")
WINDOW_DAYS = 183                     # ~6 months of history

# Detector configuration (written to merchant_config.json; the detector reads it
# from there, so these are merchant policy, not per-row labels).
RECOVERABLE_FAILURE_REASONS = [
    "insufficient_funds",
    "payment_network_error",
    "authentication_failed",
    "payment_method_declined",
    "expired_card",
]
NON_RECOVERABLE_FAILURE_REASONS = [
    "suspected_fraud",
    "unknown",
]
ALL_FAILURE_REASONS = RECOVERABLE_FAILURE_REASONS + NON_RECOVERABLE_FAILURE_REASONS

RECENCY_WINDOW_DAYS = 30
MIN_TXN_AMOUNT_PAISE = 50_000        # Rs 500
MIN_CUSTOMER_LTV_PAISE = 200_000     # Rs 2,000

TIER_HIGH_MIN_PAISE = 5_000_000      # Rs 50,000
TIER_MEDIUM_MIN_PAISE = 1_000_000    # Rs 10,000

PAYMENT_METHODS = ["card", "upi", "netbanking", "wallet"]

# Planted-cohort sizes. Explicit so the demo is provably covered.
COHORT_SIZES = {
    "A_HIGH_VALUE_RECOVERABLE": 12,
    "B1_NON_RECOVERABLE_REASON": 8,
    "B2_SUPPRESSED_CUSTOMER": 6,
    "C_ALREADY_RECOVERED": 10,
    "D_REPEATED_FAILURE": 8,
    "E_LOW_VALUE_FAILURE": 12,
    "F_HIGH_VALUE_OPPORTUNITY": 6,
    "G_STALE_FAILURE": 8,
}
TOTAL_CUSTOMERS = 500
ORGANIC_FAILURE_COUNT = 6
REFUNDED_TXN_COUNT = 15

FIRST_NAMES = [
    "Aarav", "Diya", "Vihaan", "Ananya", "Arjun", "Isha", "Kabir", "Meera",
    "Rohan", "Saanvi", "Aditya", "Nisha", "Karthik", "Priya", "Rahul", "Tara",
    "Dev", "Anika", "Siddharth", "Kavya", "Manav", "Riya", "Nikhil", "Aisha",
    "Yash", "Sneha", "Varun", "Pooja", "Imran", "Lakshmi",
]
LAST_NAMES = [
    "Sharma", "Iyer", "Patel", "Reddy", "Nair", "Gupta", "Menon", "Bose",
    "Khan", "Desai", "Rao", "Joshi", "Kapoor", "Banerjee", "Chauhan", "Pillai",
]
EMAIL_DOMAINS = ["gmail.com", "outlook.com", "yahoo.in", "protonmail.com"]
CITIES = [
    "Bengaluru", "Mumbai", "Delhi", "Hyderabad", "Pune", "Chennai",
    "Kolkata", "Ahmedabad", "Jaipur", "Kochi",
]

SUPPRESSION_REASONS = ["customer_opt_out", "chargeback_dispute", "support_escalation"]

# name, category, rupee price
PRODUCT_CATALOGUE = [
    ("Starter Plan - Monthly",        "subscription", 499),
    ("Growth Plan - Monthly",         "subscription", 1499),
    ("Scale Plan - Monthly",          "subscription", 3999),
    ("Growth Plan - Annual",          "subscription", 14999),
    ("Scale Plan - Annual",           "subscription", 39999),
    ("Enterprise Plan - Annual",      "subscription", 89999),
    ("Analytics Add-on",              "addon", 799),
    ("Priority Support Add-on",       "addon", 1299),
    ("Extra Seats Pack (5)",          "addon", 2499),
    ("Onboarding Workshop",           "service", 7999),
    ("Migration Service",             "service", 24999),
    ("Custom Integration Build",      "service", 64999),
    ("Certification Course",          "course", 2999),
    ("Advanced Course Bundle",        "course", 8999),
    ("Branded Merchandise Kit",       "merch", 199),
    ("Sticker Pack",                  "merch", 149),
    ("Hardware Reader",               "hardware", 4499),
    ("Hardware Reader Pro",           "hardware", 11999),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def rupees_to_paise(rupees: float) -> int:
    """Convert a rupee-scale generator parameter to integer paise."""
    return int(round(rupees * 100))


def iso(dt: datetime) -> str:
    return dt.astimezone(IST).isoformat()


def business_datetime(rng: random.Random, day: date) -> datetime:
    """A plausible purchase moment on a given day (IST, business-hour weighted)."""
    # Weighted toward 10:00-22:00, with a lunchtime and evening bulge.
    hour = rng.choices(
        population=list(range(24)),
        weights=[1, 1, 1, 1, 1, 2, 3, 5, 8, 12, 16, 18,
                 20, 18, 16, 15, 16, 18, 22, 24, 20, 14, 8, 4],
        k=1,
    )[0]
    return datetime(
        day.year, day.month, day.day,
        hour, rng.randrange(60), rng.randrange(60),
        tzinfo=IST,
    )


def weighted_day(rng: random.Random, start: date, end: date) -> date:
    """A day in [start, end], mildly weighted against weekends."""
    span = (end - start).days
    for _ in range(8):
        candidate = start + timedelta(days=rng.randrange(span + 1))
        if candidate.weekday() >= 5 and rng.random() < 0.45:
            continue
        return candidate
    return start + timedelta(days=rng.randrange(span + 1))


def mask_email(first: str, last: str, domain: str, n: int) -> str:
    local = f"{first.lower()}.{last.lower()}{n}"
    keep = local[:2]
    return f"{keep}{'*' * max(3, len(local) - 2)}@{domain}"


def mask_phone(rng: random.Random) -> str:
    return f"+91*****{rng.randrange(1000, 10000)}"


def tier_for_ltv(ltv_paise: int) -> str:
    if ltv_paise >= TIER_HIGH_MIN_PAISE:
        return "HIGH"
    if ltv_paise >= TIER_MEDIUM_MIN_PAISE:
        return "MEDIUM"
    return "LOW"


# ---------------------------------------------------------------------------
# Generator
# ---------------------------------------------------------------------------

class DatasetGenerator:
    def __init__(self, seed: int, end_date: date, out_dir: Path):
        self.seed = seed
        self.end_date = end_date
        self.start_date = end_date - timedelta(days=WINDOW_DAYS)
        self.out_dir = out_dir
        self.reference_dt = datetime(
            end_date.year, end_date.month, end_date.day, 23, 59, 59, tzinfo=IST
        )

        # Independent RNG streams, so changing one phase does not reshuffle another.
        self.rng_customers = random.Random(seed + 101)
        self.rng_products = random.Random(seed + 202)
        self.rng_organic = random.Random(seed + 303)
        self.rng_cohorts = random.Random(seed + 404)
        self.rng_time = random.Random(seed + 505)

        self.products: list[dict] = []
        self.customers: list[dict] = []
        self.transactions: list[dict] = []
        self.attempts: list[dict] = []
        self.manifest: dict[str, list[str]] = defaultdict(list)

        self._txn_seq = 0
        self._attempt_seq = 0

    # -- id allocation ------------------------------------------------------

    def next_txn_id(self) -> str:
        self._txn_seq += 1
        return f"txn_{self._txn_seq:06d}"

    def next_attempt_id(self) -> str:
        self._attempt_seq += 1
        return f"pa_{self._attempt_seq:06d}"

    # -- products -----------------------------------------------------------

    def build_products(self) -> None:
        for i, (name, category, price) in enumerate(PRODUCT_CATALOGUE, start=1):
            self.products.append({
                "product_id": f"prod_{i:03d}",
                "name": name,
                "category": category,
                "price_paise": rupees_to_paise(price),
                "currency": CURRENCY,
                "is_active": "true",
            })

    def products_in_price_band(self, min_rupees: float, max_rupees: float) -> list[dict]:
        lo, hi = rupees_to_paise(min_rupees), rupees_to_paise(max_rupees)
        band = [p for p in self.products if lo <= p["price_paise"] <= hi]
        return band or list(self.products)

    # -- customers ----------------------------------------------------------

    def build_customers(self) -> None:
        rng = self.rng_customers
        for i in range(1, TOTAL_CUSTOMERS + 1):
            first = rng.choice(FIRST_NAMES)
            last = rng.choice(LAST_NAMES)
            # All 500 customers pre-date the analysis window: this is an
            # established merchant and the window is its recent history. Keeps
            # "transaction after signup" true by construction.
            signup_day = weighted_day(
                rng, self.start_date - timedelta(days=540), self.start_date - timedelta(days=7)
            )
            self.customers.append({
                "customer_id": f"cust_{i:04d}",
                "external_ref": f"MERCH-CUST-{i:05d}",
                "masked_email": mask_email(first, last, rng.choice(EMAIL_DOMAINS), i),
                "masked_phone": mask_phone(rng),
                "city": rng.choice(CITIES),
                "signup_at": iso(business_datetime(rng, signup_day)),
                # placeholders; finalised in reconcile_customer_value()
                "historical_value_paise": 0,
                "lifetime_value_paise": 0,
                "tier": "LOW",
                "do_not_contact_until": "",
                "suppression_reason": "",
                "_intended_tier": "LOW",
                "_ltv_target_paise": 0,
                "_organic_override": None,
            })

        # Baseline tier intent for the organic population.
        for c in self.customers:
            roll = rng.random()
            if roll < 0.08:
                intended, target = "HIGH", rng.uniform(52_000, 180_000)
            elif roll < 0.38:
                intended, target = "MEDIUM", rng.uniform(10_500, 48_000)
            else:
                intended, target = "LOW", rng.uniform(400, 9_500)
            c["_intended_tier"] = intended
            c["_ltv_target_paise"] = rupees_to_paise(target)

    def assign_cohorts(self) -> dict[str, list[dict]]:
        """Reserve disjoint customer blocks for the planted scenarios."""
        rng = self.rng_cohorts
        pool = list(self.customers)
        rng.shuffle(pool)

        cohorts: dict[str, list[dict]] = {}
        cursor = 0
        for name in sorted(COHORT_SIZES):
            size = COHORT_SIZES[name]
            members = pool[cursor:cursor + size]
            cursor += size
            cohorts[name] = members
            for c in members:
                self.manifest[name].append(c["customer_id"])

        # Force tier intent where the scenario depends on it.
        for c in cohorts["A_HIGH_VALUE_RECOVERABLE"]:
            c["_intended_tier"] = "HIGH"
            c["_ltv_target_paise"] = rupees_to_paise(rng.uniform(62_000, 150_000))
        for c in cohorts["F_HIGH_VALUE_OPPORTUNITY"]:
            c["_intended_tier"] = "HIGH"
            c["_ltv_target_paise"] = rupees_to_paise(rng.uniform(95_000, 280_000))
        for c in cohorts["E_LOW_VALUE_FAILURE"]:
            c["_intended_tier"] = "LOW"
            c["_ltv_target_paise"] = rupees_to_paise(rng.uniform(350, 1_600))
        for c in cohorts["D_REPEATED_FAILURE"]:
            c["_intended_tier"] = "MEDIUM"
            c["_ltv_target_paise"] = rupees_to_paise(rng.uniform(14_000, 44_000))
        # B2 must clear every value floor so that suppression is the ONLY binding
        # constraint. Otherwise the cohort silently tests the wrong exclusion.
        for c in cohorts["B2_SUPPRESSED_CUSTOMER"]:
            c["_intended_tier"] = "MEDIUM"
            c["_ltv_target_paise"] = rupees_to_paise(rng.uniform(18_000, 60_000))
        # E must stay under the LTV floor, so it gets no organic revenue at all.
        for c in cohorts["E_LOW_VALUE_FAILURE"]:
            c["_organic_override"] = 0

        # Suppression state — raw merchant state, not a detector label.
        for c in cohorts["B2_SUPPRESSED_CUSTOMER"]:
            days_ahead = rng.randrange(20, 200)
            until = self.reference_dt + timedelta(days=days_ahead)
            c["do_not_contact_until"] = iso(until.replace(hour=0, minute=0, second=0))
            c["suppression_reason"] = rng.choice(SUPPRESSION_REASONS)

        # A handful of EXPIRED suppressions elsewhere: the detector must compare
        # against the reference date rather than merely checking for presence.
        expired_pool = [c for c in pool[cursor:] if not c["do_not_contact_until"]]
        for c in expired_pool[:9]:
            until = self.reference_dt - timedelta(days=rng.randrange(30, 180))
            c["do_not_contact_until"] = iso(until.replace(hour=0, minute=0, second=0))
            c["suppression_reason"] = rng.choice(SUPPRESSION_REASONS)
            self.manifest["H_EXPIRED_SUPPRESSION"].append(c["customer_id"])

        self.cohorts = cohorts
        return cohorts

    # -- transaction / attempt construction ---------------------------------

    def add_transaction(
        self,
        rng: random.Random,
        customer: dict,
        product: dict,
        created: datetime,
        outcome: str,                    # "captured" | "failed" | "recovered" | "refunded"
        failure_reasons: list[str] | None = None,
        quantity: int = 1,
    ) -> dict:
        """Create one transaction plus its attempt chain.

        `outcome` drives the attempt chain shape:
          captured  -> [SUCCESS]
          failed    -> [FAILED x len(failure_reasons)]
          recovered -> [FAILED x n, SUCCESS]
          refunded  -> [SUCCESS] and transaction marked REFUNDED
        """
        amount = product["price_paise"] * quantity
        txn_id = self.next_txn_id()
        method = rng.choice(PAYMENT_METHODS)

        chain: list[dict] = []
        prev_id = ""
        cursor = created

        if outcome in ("failed", "recovered"):
            reasons = failure_reasons or ["payment_method_declined"]
            for idx, reason in enumerate(reasons, start=1):
                if idx > 1:
                    cursor = cursor + timedelta(
                        minutes=rng.choice([3, 11, 47, 180, 720, 1_440, 2_880])
                    )
                attempt_id = self.next_attempt_id()
                chain.append({
                    "attempt_id": attempt_id,
                    "transaction_id": txn_id,
                    "customer_id": customer["customer_id"],
                    "amount_paise": amount,
                    "currency": CURRENCY,
                    "status": "FAILED",
                    "failure_reason": reason,
                    "method": method,
                    "attempt_no": idx,
                    "retry_of_attempt_id": prev_id,
                    "gateway_ref": f"pay_SYN{self._attempt_seq:08d}",
                    "created_at": iso(cursor),
                })
                prev_id = attempt_id

        if outcome in ("captured", "recovered", "refunded"):
            if outcome == "recovered":
                cursor = cursor + timedelta(
                    minutes=rng.choice([25, 90, 360, 1_440, 2_880, 5_760])
                )
            attempt_id = self.next_attempt_id()
            chain.append({
                "attempt_id": attempt_id,
                "transaction_id": txn_id,
                "customer_id": customer["customer_id"],
                "amount_paise": amount,
                "currency": CURRENCY,
                "status": "SUCCESS",
                "failure_reason": "",
                "method": method,
                "attempt_no": len(chain) + 1,
                "retry_of_attempt_id": prev_id,
                "gateway_ref": f"pay_SYN{self._attempt_seq:08d}",
                "created_at": iso(cursor),
            })

        status = {
            "captured": "CAPTURED",
            "recovered": "CAPTURED",
            "refunded": "REFUNDED",
            "failed": "FAILED",
        }[outcome]

        refunded_at = ""
        if outcome == "refunded":
            refunded_at = iso(cursor + timedelta(days=rng.randrange(2, 21)))

        txn = {
            "transaction_id": txn_id,
            "customer_id": customer["customer_id"],
            "product_id": product["product_id"],
            "quantity": quantity,
            "amount_paise": amount,
            "currency": CURRENCY,
            "status": status,
            "method": method,
            "attempt_count": len(chain),
            "created_at": iso(created),
            "updated_at": chain[-1]["created_at"] if chain else iso(created),
            "refunded_at": refunded_at,
        }
        self.transactions.append(txn)
        self.attempts.extend(chain)
        return txn

    # -- planted scenarios --------------------------------------------------

    def recent_day(self, rng: random.Random, min_ago: int, max_ago: int) -> date:
        return self.end_date - timedelta(days=rng.randrange(min_ago, max_ago + 1))

    def build_planted_scenarios(self) -> None:
        rng = self.rng_cohorts
        co = self.cohorts

        # A — high-value customer, recoverable reason, no successful retry, contactable.
        for c in co["A_HIGH_VALUE_RECOVERABLE"]:
            product = rng.choice(self.products_in_price_band(2_999, 14_999))
            day = self.recent_day(rng, 2, 25)
            reason = rng.choice(RECOVERABLE_FAILURE_REASONS)
            txn = self.add_transaction(
                rng, c, product, business_datetime(self.rng_time, day),
                "failed", [reason],
            )
            self.manifest["_txn_A_HIGH_VALUE_RECOVERABLE"].append(txn["transaction_id"])

        # B1 — failure reason we classify as non-recoverable.
        for c in co["B1_NON_RECOVERABLE_REASON"]:
            product = rng.choice(self.products_in_price_band(1_499, 39_999))
            day = self.recent_day(rng, 2, 25)
            reason = rng.choice(NON_RECOVERABLE_FAILURE_REASONS)
            txn = self.add_transaction(
                rng, c, product, business_datetime(self.rng_time, day),
                "failed", [reason],
            )
            self.manifest["_txn_B1_NON_RECOVERABLE_REASON"].append(txn["transaction_id"])

        # B2 — recoverable failure, but customer is under active suppression.
        for c in co["B2_SUPPRESSED_CUSTOMER"]:
            product = rng.choice(self.products_in_price_band(1_499, 24_999))
            day = self.recent_day(rng, 2, 25)
            reason = rng.choice(RECOVERABLE_FAILURE_REASONS)
            txn = self.add_transaction(
                rng, c, product, business_datetime(self.rng_time, day),
                "failed", [reason],
            )
            self.manifest["_txn_B2_SUPPRESSED_CUSTOMER"].append(txn["transaction_id"])

        # C — failed, then genuinely paid. Must never be counted as recoverable.
        for c in co["C_ALREADY_RECOVERED"]:
            product = rng.choice(self.products_in_price_band(999, 24_999))
            day = self.recent_day(rng, 3, 25)
            reason = rng.choice(RECOVERABLE_FAILURE_REASONS)
            txn = self.add_transaction(
                rng, c, product, business_datetime(self.rng_time, day),
                "recovered", [reason],
            )
            self.manifest["_txn_C_ALREADY_RECOVERED"].append(txn["transaction_id"])

        # D — repeated failures on one transaction, still unpaid.
        for c in co["D_REPEATED_FAILURE"]:
            product = rng.choice(self.products_in_price_band(1_299, 8_999))
            day = self.recent_day(rng, 4, 25)
            n = rng.randrange(2, 5)
            reasons = [rng.choice(RECOVERABLE_FAILURE_REASONS) for _ in range(n)]
            txn = self.add_transaction(
                rng, c, product, business_datetime(self.rng_time, day),
                "failed", reasons,
            )
            self.manifest["_txn_D_REPEATED_FAILURE"].append(txn["transaction_id"])

        # E — genuine, recent, recoverable failure that is simply too small to chase.
        for idx, c in enumerate(co["E_LOW_VALUE_FAILURE"]):
            if idx % 2 == 0:
                # tiny ticket: a real failure, simply not worth an intervention
                product = rng.choice(self.products_in_price_band(149, 199))
            else:
                # respectable ticket, but a customer with almost no history
                product = rng.choice(self.products_in_price_band(1_499, 3_999))
            day = self.recent_day(rng, 2, 25)
            reason = rng.choice(RECOVERABLE_FAILURE_REASONS)
            txn = self.add_transaction(
                rng, c, product, business_datetime(self.rng_time, day),
                "failed", [reason],
            )
            self.manifest["_txn_E_LOW_VALUE_FAILURE"].append(txn["transaction_id"])

        # F — large-ticket failure with good recovery characteristics.
        for c in co["F_HIGH_VALUE_OPPORTUNITY"]:
            product = rng.choice(self.products_in_price_band(24_999, 89_999))
            day = self.recent_day(rng, 2, 20)
            reason = rng.choice(["insufficient_funds", "payment_network_error", "expired_card"])
            txn = self.add_transaction(
                rng, c, product, business_datetime(self.rng_time, day),
                "failed", [reason],
            )
            self.manifest["_txn_F_HIGH_VALUE_OPPORTUNITY"].append(txn["transaction_id"])

        # G — recoverable in kind, but far outside the recency window.
        for c in co["G_STALE_FAILURE"]:
            product = rng.choice(self.products_in_price_band(1_499, 39_999))
            day = self.recent_day(rng, 65, 170)
            reason = rng.choice(RECOVERABLE_FAILURE_REASONS)
            txn = self.add_transaction(
                rng, c, product, business_datetime(self.rng_time, day),
                "failed", [reason],
            )
            self.manifest["_txn_G_STALE_FAILURE"].append(txn["transaction_id"])

    # -- organic background -------------------------------------------------

    def build_organic_history(self) -> None:
        rng = self.rng_organic
        planted_ids = {cid for name in sorted(self.manifest)
                       if not name.startswith("_")
                       for cid in self.manifest[name]}

        for c in self.customers:
            intended = c["_intended_tier"]
            if intended == "HIGH":
                n = rng.randrange(4, 9)
                band = (1_499, 89_999)
            elif intended == "MEDIUM":
                n = rng.randrange(2, 6)
                band = (499, 14_999)
            else:
                n = rng.randrange(0, 3)
                band = (149, 3_999)
            if c["_organic_override"] is not None:
                n = c["_organic_override"]

            for _ in range(n):
                product = rng.choice(self.products_in_price_band(*band))
                day = weighted_day(rng, self.start_date, self.end_date)
                qty = 1 if rng.random() < 0.88 else rng.randrange(2, 4)
                self.add_transaction(
                    rng, c, product, business_datetime(self.rng_time, day),
                    "captured", quantity=qty,
                )

        # A little organic failure noise, on customers with no planted scenario,
        # so the detector is not scoring an artificially clean world.
        candidates = [c for c in self.customers if c["customer_id"] not in planted_ids]
        candidates.sort(key=lambda c: c["customer_id"])
        rng.shuffle(candidates)
        for c in candidates[:ORGANIC_FAILURE_COUNT]:
            product = rng.choice(self.products_in_price_band(699, 11_999))
            day = weighted_day(rng, self.start_date, self.end_date)
            reason = rng.choice(ALL_FAILURE_REASONS)
            txn = self.add_transaction(
                rng, c, product, business_datetime(self.rng_time, day),
                "failed", [reason],
            )
            self.manifest["I_ORGANIC_FAILURE"].append(c["customer_id"])
            self.manifest["_txn_I_ORGANIC_FAILURE"].append(txn["transaction_id"])

        # Convert a few captured transactions into refunds, for revenue realism.
        captured = [t for t in self.transactions if t["status"] == "CAPTURED"
                    and not any(a["transaction_id"] == t["transaction_id"]
                                and a["status"] == "FAILED" for a in self.attempts)]
        captured.sort(key=lambda t: t["transaction_id"])
        rng.shuffle(captured)
        for t in captured[:REFUNDED_TXN_COUNT]:
            t["status"] = "REFUNDED"
            settled = datetime.fromisoformat(t["updated_at"])
            t["refunded_at"] = iso(settled + timedelta(days=rng.randrange(2, 21)))
            self.manifest["J_REFUNDED"].append(t["transaction_id"])

    # -- value reconciliation ----------------------------------------------

    def reconcile_customer_value(self) -> None:
        """LTV = pre-window historical value + in-window captured revenue.

        Derived last so lifetime_value and tier can never contradict the
        transaction records the detector reads.
        """
        captured_by_customer: dict[str, int] = defaultdict(int)
        for t in self.transactions:
            if t["status"] == "CAPTURED":
                captured_by_customer[t["customer_id"]] += t["amount_paise"]

        for c in self.customers:
            in_window = captured_by_customer.get(c["customer_id"], 0)
            target = c["_ltv_target_paise"]
            lifetime = max(target, in_window)
            historical = lifetime - in_window
            c["historical_value_paise"] = historical
            c["lifetime_value_paise"] = lifetime
            c["tier"] = tier_for_ltv(lifetime)

    # -- derived (config-driven) opportunity view ---------------------------

    def derive_opportunity_view(self) -> dict:
        """Apply the SAME predicate the TypeScript detector will apply.

        This is computed here only for the summary and the validator's coverage
        assertions. It is deliberately NOT written back onto any row.
        """
        customers_by_id = {c["customer_id"]: c for c in self.customers}
        txns_by_id = {t["transaction_id"]: t for t in self.transactions}

        attempts_by_txn: dict[str, list[dict]] = defaultdict(list)
        for a in self.attempts:
            attempts_by_txn[a["transaction_id"]].append(a)

        cutoff = self.reference_dt - timedelta(days=RECENCY_WINDOW_DAYS)
        qualifying: list[dict] = []

        for txn_id in sorted(attempts_by_txn):
            chain = sorted(attempts_by_txn[txn_id], key=lambda a: a["attempt_no"])
            if any(a["status"] == "SUCCESS" for a in chain):
                continue                                   # already recovered
            failed = [a for a in chain if a["status"] == "FAILED"]
            if not failed:
                continue
            latest = failed[-1]
            if latest["failure_reason"] not in RECOVERABLE_FAILURE_REASONS:
                continue                                   # non-recoverable reason
            if datetime.fromisoformat(latest["created_at"]) < cutoff:
                continue                                   # stale
            txn = txns_by_id[txn_id]
            if txn["amount_paise"] < MIN_TXN_AMOUNT_PAISE:
                continue                                   # below ticket floor
            cust = customers_by_id[txn["customer_id"]]
            if cust["lifetime_value_paise"] < MIN_CUSTOMER_LTV_PAISE:
                continue                                   # below LTV floor
            dnc = cust["do_not_contact_until"]
            if dnc and datetime.fromisoformat(dnc) > self.reference_dt:
                continue                                   # actively suppressed
            qualifying.append({
                "transaction_id": txn_id,
                "customer_id": cust["customer_id"],
                "amount_paise": txn["amount_paise"],
                "failure_reason": latest["failure_reason"],
                "tier": cust["tier"],
                "attempt_count": len(failed),
            })

        return {
            "targets": qualifying,
            "count": len(qualifying),
            "distinct_customers": len({q["customer_id"] for q in qualifying}),
            "recoverable_amount_paise": sum(q["amount_paise"] for q in qualifying),
        }

    # -- output -------------------------------------------------------------

    def merchant_config(self) -> dict:
        return {
            "schema_version": "1.0.0",
            "merchant": {
                "merchant_id": "merch_demo_001",
                "name": "Nimbus Commerce Pvt Ltd",
                "business_type": "saas_and_services",
                "timezone": "Asia/Kolkata",
                "currency": CURRENCY,
                "mode": "TEST",
            },
            "dataset": {
                "generator_version": "1.0.0",
                "seed": self.seed,
                "reference_date": self.end_date.isoformat(),
                "reference_datetime": iso(self.reference_dt),
                "window_start_date": self.start_date.isoformat(),
                "window_days": WINDOW_DAYS,
                "note": (
                    "reference_date is the dataset's 'as of' instant. The detector must "
                    "evaluate recency and suppression against this value, not the wall "
                    "clock, or the demo stops being reproducible."
                ),
            },
            "detector_config": {
                "detector_key": "FAILED_PAYMENT_RECOVERY",
                "detector_version": "1.0.0",
                "recoverable_failure_reasons": RECOVERABLE_FAILURE_REASONS,
                "non_recoverable_failure_reasons": NON_RECOVERABLE_FAILURE_REASONS,
                "recency_window_days": RECENCY_WINDOW_DAYS,
                "min_transaction_amount_paise": MIN_TXN_AMOUNT_PAISE,
                "min_customer_lifetime_value_paise": MIN_CUSTOMER_LTV_PAISE,
                "note": (
                    "Classification lives here as merchant policy, never as a per-row "
                    "column. Rows carry evidence only."
                ),
            },
            "customer_tiers": {
                "HIGH": {"min_lifetime_value_paise": TIER_HIGH_MIN_PAISE},
                "MEDIUM": {"min_lifetime_value_paise": TIER_MEDIUM_MIN_PAISE},
                "LOW": {"min_lifetime_value_paise": 0},
            },
            "guardrail_policy": {
                "policy_version": 1,
                "rules": {
                    "MAX_DISCOUNT_BPS": {"severity": "BLOCK", "limit": 1500},
                    "MAX_SINGLE_ACTION_EXPOSURE_PAISE": {"severity": "BLOCK", "limit": 5_000_000},
                    "DAILY_DISCOUNT_BUDGET_PAISE": {"severity": "BLOCK", "limit": 2_500_000},
                    "MIN_EXPECTED_NET_PAISE": {"severity": "BLOCK", "limit": 100_000},
                    "MAX_CONTACTS_PER_CUSTOMER": {"severity": "BLOCK", "limit": 2, "window_days": 7},
                    "DO_NOT_CONTACT": {"severity": "BLOCK"},
                    "QUIET_HOURS": {"severity": "REQUIRE_APPROVAL", "start_hour": 21, "end_hour": 9},
                    "MAX_CONCURRENT_LIVE": {"severity": "BLOCK", "limit": 3},
                    "TEST_MODE_ONLY": {"severity": "BLOCK"},
                    "LOW_CONFIDENCE": {"severity": "REQUIRE_APPROVAL", "min_confidence": "MEDIUM"},
                },
            },
            "playbooks": [
                {
                    "key": "REMINDER_ONLY",
                    "name": "Plain retry reminder",
                    "action_type": "REMINDER_ONLY",
                    "default_discount_bps": 0,
                    "channel_cost_paise": 50,
                },
                {
                    "key": "PAYMENT_LINK_PLAIN",
                    "name": "Payment link, no incentive",
                    "action_type": "PAYMENT_LINK_PLAIN",
                    "default_discount_bps": 0,
                    "channel_cost_paise": 50,
                },
                {
                    "key": "PAYMENT_LINK_WITH_OFFER",
                    "name": "Payment link with capped discount",
                    "action_type": "PAYMENT_LINK_WITH_OFFER",
                    "default_discount_bps": 1000,
                    "channel_cost_paise": 50,
                },
            ],
            "playbook_priors": self.playbook_priors(),
            "estimator_config": {
                "gateway_fee_bps": 200,
                "attribution_window_days": 14,
                "note": (
                    "Priors are Beta(alpha, beta) pseudo-counts seeded from published "
                    "recovery-rate ranges. They are starting beliefs, not observations, "
                    "and are overwritten by real outcomes as the LEARN step runs."
                ),
            },
        }

    def playbook_priors(self) -> list[dict]:
        """Beta priors per (playbook, failure_reason). Deterministic, hand-set."""
        base = {
            "insufficient_funds":      {"REMINDER_ONLY": 0.18, "PAYMENT_LINK_PLAIN": 0.26, "PAYMENT_LINK_WITH_OFFER": 0.38},
            "payment_network_error":   {"REMINDER_ONLY": 0.34, "PAYMENT_LINK_PLAIN": 0.46, "PAYMENT_LINK_WITH_OFFER": 0.52},
            "authentication_failed":   {"REMINDER_ONLY": 0.28, "PAYMENT_LINK_PLAIN": 0.40, "PAYMENT_LINK_WITH_OFFER": 0.47},
            "payment_method_declined": {"REMINDER_ONLY": 0.16, "PAYMENT_LINK_PLAIN": 0.24, "PAYMENT_LINK_WITH_OFFER": 0.35},
            "expired_card":            {"REMINDER_ONLY": 0.22, "PAYMENT_LINK_PLAIN": 0.33, "PAYMENT_LINK_WITH_OFFER": 0.41},
        }
        strength = 40  # pseudo-observations behind each prior
        priors = []
        for reason in sorted(base):
            for playbook in sorted(base[reason]):
                rate = base[reason][playbook]
                alpha = round(rate * strength, 2)
                priors.append({
                    "playbook_key": playbook,
                    "failure_reason": reason,
                    "alpha": alpha,
                    "beta": round(strength - alpha, 2),
                    "implied_base_rate": rate,
                })
        return priors

    def summary(self, opportunity_view: dict) -> dict:
        total_value = sum(t["amount_paise"] for t in self.transactions)
        captured = sum(t["amount_paise"] for t in self.transactions if t["status"] == "CAPTURED")
        refunded = sum(t["amount_paise"] for t in self.transactions if t["status"] == "REFUNDED")
        failed_txn = [t for t in self.transactions if t["status"] == "FAILED"]
        failed_value = sum(t["amount_paise"] for t in failed_txn)
        failed_attempts = [a for a in self.attempts if a["status"] == "FAILED"]

        reason_dist = Counter(a["failure_reason"] for a in failed_attempts)
        tier_dist = Counter(c["tier"] for c in self.customers)
        status_dist = Counter(t["status"] for t in self.transactions)

        suppressed = [
            c for c in self.customers
            if c["do_not_contact_until"]
            and datetime.fromisoformat(c["do_not_contact_until"]) > self.reference_dt
        ]
        expired_suppression = [
            c for c in self.customers
            if c["do_not_contact_until"]
            and datetime.fromisoformat(c["do_not_contact_until"]) <= self.reference_dt
        ]

        return {
            "generated_with": {
                "generator_version": "1.0.0",
                "seed": self.seed,
                "reference_date": self.end_date.isoformat(),
                "window_start_date": self.start_date.isoformat(),
            },
            "row_counts": {
                "customers": len(self.customers),
                "products": len(self.products),
                "transactions": len(self.transactions),
                "payment_attempts": len(self.attempts),
                "failed_payment_attempts": len(failed_attempts),
                "successful_payment_attempts": len(self.attempts) - len(failed_attempts),
            },
            "money_paise": {
                "total_transaction_value": total_value,
                "captured_revenue": captured,
                "refunded_value": refunded,
                "failed_payment_value": failed_value,
            },
            "money_rupees_display": {
                "total_transaction_value": round(total_value / 100, 2),
                "captured_revenue": round(captured / 100, 2),
                "refunded_value": round(refunded / 100, 2),
                "failed_payment_value": round(failed_value / 100, 2),
            },
            "customers": {
                "total": len(self.customers),
                "with_failed_payment": len({a["customer_id"] for a in failed_attempts}),
                "actively_suppressed": len(suppressed),
                "expired_suppression": len(expired_suppression),
                "tier_distribution": {k: tier_dist[k] for k in sorted(tier_dist)},
            },
            "transactions": {
                "status_distribution": {k: status_dist[k] for k in sorted(status_dist)},
                "multi_attempt_transactions": sum(
                    1 for t in self.transactions if t["attempt_count"] > 1
                ),
            },
            "failure_reason_distribution": {k: reason_dist[k] for k in sorted(reason_dist)},
            "derived_opportunity_view": {
                "note": (
                    "Computed by applying detector_config to the raw rows. Not stored on "
                    "any row; recomputed independently by the validator and later by the "
                    "TypeScript detector."
                ),
                "qualifying_transactions": opportunity_view["count"],
                "distinct_customers": opportunity_view["distinct_customers"],
                "recoverable_amount_paise": opportunity_view["recoverable_amount_paise"],
                "recoverable_amount_rupees_display": round(
                    opportunity_view["recoverable_amount_paise"] / 100, 2
                ),
                "by_tier": dict(sorted(
                    Counter(t["tier"] for t in opportunity_view["targets"]).items()
                )),
                "by_failure_reason": dict(sorted(
                    Counter(t["failure_reason"] for t in opportunity_view["targets"]).items()
                )),
            },
            "planted_cohort_sizes": {k: COHORT_SIZES[k] for k in sorted(COHORT_SIZES)},
        }

    def write(self) -> dict:
        self.out_dir.mkdir(parents=True, exist_ok=True)

        customer_cols = [
            "customer_id", "external_ref", "masked_email", "masked_phone", "city",
            "signup_at", "historical_value_paise", "lifetime_value_paise", "tier",
            "do_not_contact_until", "suppression_reason",
        ]
        product_cols = ["product_id", "name", "category", "price_paise", "currency", "is_active"]
        txn_cols = [
            "transaction_id", "customer_id", "product_id", "quantity", "amount_paise",
            "currency", "status", "method", "attempt_count", "created_at", "updated_at",
            "refunded_at",
        ]
        attempt_cols = [
            "attempt_id", "transaction_id", "customer_id", "amount_paise", "currency",
            "status", "failure_reason", "method", "attempt_no", "retry_of_attempt_id",
            "gateway_ref", "created_at",
        ]

        self._write_csv("customers.csv", customer_cols,
                        sorted(self.customers, key=lambda r: r["customer_id"]))
        self._write_csv("products.csv", product_cols,
                        sorted(self.products, key=lambda r: r["product_id"]))
        self._write_csv("transactions.csv", txn_cols,
                        sorted(self.transactions, key=lambda r: r["transaction_id"]))
        self._write_csv("payment_attempts.csv", attempt_cols,
                        sorted(self.attempts, key=lambda r: r["attempt_id"]))

        self._write_json("merchant_config.json", self.merchant_config())

        view = self.derive_opportunity_view()
        summary = self.summary(view)
        self._write_json("dataset_summary.json", summary)

        manifest = {
            "_warning": (
                "TEST FIXTURE ONLY. This file records which planted scenario each row "
                "belongs to. It must never be loaded by the RevenuePilot application - "
                "doing so would leak labels the detector is supposed to derive."
            ),
            "cohorts": {k: sorted(self.manifest[k]) for k in sorted(self.manifest)},
        }
        self._write_json("scenario_manifest.json", manifest)

        return summary

    def _write_csv(self, filename: str, columns: list[str], rows: list[dict]) -> None:
        path = self.out_dir / filename
        with path.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=columns, lineterminator="\n",
                                    extrasaction="ignore")
            writer.writeheader()
            for row in rows:
                writer.writerow(row)

    def _write_json(self, filename: str, payload: dict) -> None:
        path = self.out_dir / filename
        with path.open("w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, sort_keys=False, ensure_ascii=True)
            fh.write("\n")

    def run(self) -> dict:
        self.build_products()
        self.build_customers()
        self.assign_cohorts()
        self.build_planted_scenarios()
        self.build_organic_history()
        self.reconcile_customer_value()
        return self.write()


# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the RevenuePilot synthetic dataset.")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--end-date", type=str, default=DEFAULT_END_DATE,
                        help="Dataset reference date, YYYY-MM-DD. Fixed by default so "
                             "output is reproducible across days.")
    parser.add_argument("--out", type=str, default="data")
    args = parser.parse_args()

    end_date = date.fromisoformat(args.end_date)
    gen = DatasetGenerator(seed=args.seed, end_date=end_date, out_dir=Path(args.out))
    summary = gen.run()

    rc = summary["row_counts"]
    money = summary["money_rupees_display"]
    view = summary["derived_opportunity_view"]
    print(f"seed={args.seed} reference_date={args.end_date} -> {args.out}/")
    print(f"  customers={rc['customers']} products={rc['products']} "
          f"transactions={rc['transactions']} attempts={rc['payment_attempts']} "
          f"failed_attempts={rc['failed_payment_attempts']}")
    print(f"  captured=Rs {money['captured_revenue']:,.2f}  "
          f"failed=Rs {money['failed_payment_value']:,.2f}")
    print(f"  qualifying opportunities={view['qualifying_transactions']} "
          f"worth Rs {view['recoverable_amount_rupees_display']:,.2f}")


if __name__ == "__main__":
    main()
