/**
 * Seed catalogue. At least five products, including deliberately scarce stock
 * ("Limited Hoodie", qty 1) so oversell and concurrency tests are meaningful
 * rather than theoretical.
 */
import type { Product } from './domain/types.js';
import type { ProductRepository } from './repository.js';

export const SEED_PRODUCTS: Product[] = [
  { id: 'p-mug', name: 'Ceramic Mug', unitPriceCents: 1299, inventory: 100 },
  { id: 'p-tee', name: 'Cotton T-Shirt', unitPriceCents: 1999, inventory: 50 },
  { id: 'p-cap', name: 'Baseball Cap', unitPriceCents: 1500, inventory: 20 },
  { id: 'p-bottle', name: 'Steel Water Bottle', unitPriceCents: 2499, inventory: 8 },
  { id: 'p-hoodie', name: 'Limited Hoodie', unitPriceCents: 5999, inventory: 1 },
  { id: 'p-sticker', name: 'Sticker Pack', unitPriceCents: 499, inventory: 3 },
];

export function seedProducts(products: ProductRepository, catalogue: Product[] = SEED_PRODUCTS): void {
  for (const product of catalogue) {
    // Copy so mutating inventory in the store never touches the seed constant.
    products.save({ ...product });
  }
}
