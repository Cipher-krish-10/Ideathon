import "server-only";

import type { Prisma, ProductCategory } from "@/generated/prisma/client";
import { ScopedRepository } from "./context";

export class ProductRepository extends ScopedRepository {
  findById(id: string) {
    return this.db.product.findFirst({ where: this.scope.where({ id }) });
  }

  /** Look up by the dataset identifier, e.g. "prod_001". */
  findBySourceRef(sourceRef: string) {
    return this.db.product.findFirst({ where: this.scope.where({ sourceRef }) });
  }

  list(options: { category?: ProductCategory; activeOnly?: boolean } = {}) {
    const { category, activeOnly } = options;
    return this.db.product.findMany({
      where: this.scope.where({
        ...(category ? { category } : {}),
        ...(activeOnly ? { isActive: true } : {}),
      }),
      orderBy: { sourceRef: "asc" },
    });
  }

  count(filter: Prisma.ProductWhereInput = {}) {
    return this.db.product.count({ where: this.scope.where(filter) });
  }
}
