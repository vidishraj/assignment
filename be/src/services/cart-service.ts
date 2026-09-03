/**
 * Cart operations.
 *
 * A cart holds product references + quantities — it does NOT freeze prices.
 * Prices and totals are computed live from the current product catalogue when
 * the cart is viewed, and are frozen only at checkout (into the order snapshot).
 * So if a product's price changes after an item is added but before checkout,
 * the customer is quoted and charged the new price. This is a deliberate
 * choice, recorded in DECISIONS.md.
 */
import { randomUUID } from 'node:crypto';
import type { Cart, CartItem } from '../domain/types.js';
import type { Cents } from '../money.js';
import { lineTotal, sumCents } from '../money.js';
import { AppError } from '../errors.js';
import type { Repositories } from '../repository.js';

/**
 * The most units of a single product one cart line may hold. This is a domain
 * cap, not a technical one: a real checkout never legitimately orders thousands
 * of one item, and bounding it here keeps every line total (and therefore every
 * subtotal) a safe integer, so the integer-cents money invariant can't be
 * defeated by a huge quantity overflowing 2^53. Enforced on the ACCUMULATED
 * quantity, so repeated adds can't sneak past it either. (See DECISIONS.md.)
 */
export const MAX_LINE_QUANTITY = 1000;

export interface CartViewLine {
  productId: string;
  name: string;
  unitPriceCents: Cents;
  quantity: number;
  lineTotalCents: Cents;
}

export interface CartView {
  id: string;
  status: Cart['status'];
  items: CartViewLine[];
  subtotalCents: Cents;
  orderId?: string;
}

function assertPositiveQuantity(quantity: unknown): number {
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
    throw new AppError('INVALID_QUANTITY', 'quantity must be a positive integer', { quantity });
  }
  return quantity;
}

/** Reject a resulting line quantity above the domain cap. */
function assertWithinLineLimit(quantity: number, productId: string): void {
  if (quantity > MAX_LINE_QUANTITY) {
    throw new AppError(
      'QUANTITY_LIMIT_EXCEEDED',
      `a cart line may hold at most ${MAX_LINE_QUANTITY} units of a product`,
      { productId, requested: quantity, limit: MAX_LINE_QUANTITY },
    );
  }
}

export function makeCartService(repos: Repositories) {
  function load(cartId: string): Cart {
    const cart = repos.carts.get(cartId);
    if (!cart) throw new AppError('CART_NOT_FOUND', `no cart ${cartId}`, { cartId });
    return cart;
  }

  /** Mutations are only allowed on an OPEN cart. */
  function loadOpen(cartId: string): Cart {
    const cart = load(cartId);
    if (cart.status !== 'OPEN') {
      throw new AppError('CART_ALREADY_CHECKED_OUT', `cart ${cartId} is already checked out`, {
        cartId,
        orderId: cart.orderId,
      });
    }
    return cart;
  }

  function requireProduct(productId: string) {
    const product = repos.products.get(productId);
    if (!product) {
      throw new AppError('PRODUCT_NOT_FOUND', `no product ${productId}`, { productId });
    }
    return product;
  }

  function view(cartId: string): CartView {
    const cart = load(cartId);
    const items: CartViewLine[] = cart.items.map((item) => {
      const product = requireProduct(item.productId);
      return {
        productId: product.id,
        name: product.name,
        unitPriceCents: product.unitPriceCents,
        quantity: item.quantity,
        lineTotalCents: lineTotal(product.unitPriceCents, item.quantity),
      };
    });
    return {
      id: cart.id,
      status: cart.status,
      items,
      subtotalCents: sumCents(items.map((i) => i.lineTotalCents)),
      ...(cart.orderId ? { orderId: cart.orderId } : {}),
    };
  }

  return {
    create(): CartView {
      const cart: Cart = {
        id: randomUUID(),
        status: 'OPEN',
        items: [],
        createdAt: new Date().toISOString(),
      };
      repos.carts.save(cart);
      return view(cart.id);
    },

    view,

    /** Add `quantity` of a product, accumulating onto any existing line. */
    addItem(cartId: string, productId: string, quantity: unknown): CartView {
      const qty = assertPositiveQuantity(quantity);
      const cart = loadOpen(cartId);
      requireProduct(productId);
      const existing = cart.items.find((i) => i.productId === productId);
      const resulting = existing ? existing.quantity + qty : qty;
      assertWithinLineLimit(resulting, productId);
      if (existing) existing.quantity = resulting;
      else cart.items.push({ productId, quantity: qty });
      repos.carts.save(cart);
      return view(cartId);
    },

    /** Set the exact quantity of an item already in the cart. */
    setQuantity(cartId: string, productId: string, quantity: unknown): CartView {
      const qty = assertPositiveQuantity(quantity);
      assertWithinLineLimit(qty, productId);
      const cart = loadOpen(cartId);
      const item = cart.items.find((i) => i.productId === productId);
      if (!item) {
        throw new AppError('ITEM_NOT_IN_CART', `product ${productId} is not in cart ${cartId}`, {
          cartId,
          productId,
        });
      }
      item.quantity = qty;
      repos.carts.save(cart);
      return view(cartId);
    },

    removeItem(cartId: string, productId: string): CartView {
      const cart = loadOpen(cartId);
      const before = cart.items.length;
      cart.items = cart.items.filter((i: CartItem) => i.productId !== productId);
      if (cart.items.length === before) {
        throw new AppError('ITEM_NOT_IN_CART', `product ${productId} is not in cart ${cartId}`, {
          cartId,
          productId,
        });
      }
      repos.carts.save(cart);
      return view(cartId);
    },
  };
}

export type CartService = ReturnType<typeof makeCartService>;
