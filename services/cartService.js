/*
WinWin Cart Service
MASTER v8 FINAL
ES Modules
*/

import { prisma } from "../lib/prisma.js"
import { computeCart } from "./pricingEngine.js"

export async function findActiveCart(customerId) {

  let cart = await prisma.cart.findFirst({
    where: {
      customerId,
      status: "ACTIVE"
    }
  })

  if (!cart) {
    cart = await prisma.cart.create({
      data: {
        customerId,
        status: "ACTIVE"
      }
    })
  }

  return cart
}

export async function addItem(customerId, variantId, quantity, pricingMaps) {

  return prisma.$transaction(async (tx) => {

    const cart = await findActiveCart(customerId)

    const existingItem = await tx.cartItem.findFirst({
      where: {
        cartId: cart.id,
        variantId
      }
    })

    const newQty = existingItem
      ? existingItem.quantity + quantity
      : quantity

    // 🔥 PASSAGE PAR LE PRICING ENGINE AVANT ÉCRITURE
    const computed = computeCart(
      [{ variantId, quantity: newQty }],
      pricingMaps
    )

    const validatedItem = computed.items[0]

    if (existingItem) {

      await tx.cartItem.update({
        where: { id: existingItem.id },
        data: {
          quantity: validatedItem.quantity
        }
      })

    } else {

      await tx.cartItem.create({
        data: {
          cartId: cart.id,
          variantId,
          quantity: validatedItem.quantity
        }
      })

    }

    return getCart(customerId, pricingMaps)

  })

}

export async function updateItem(customerId, variantId, quantity, pricingMaps) {

  return prisma.$transaction(async (tx) => {

    const cart = await findActiveCart(customerId)

    const item = await tx.cartItem.findFirst({
      where: {
        cartId: cart.id,
        variantId
      }
    })

    if (!item) {
      throw new Error("CART_ITEM_NOT_FOUND")
    }

    if (quantity <= 0) {

      await tx.cartItem.delete({
        where: { id: item.id }
      })

    } else {

      const computed = computeCart(
        [{ variantId, quantity }],
        pricingMaps
      )

      const validatedItem = computed.items[0]

      await tx.cartItem.update({
        where: { id: item.id },
        data: {
          quantity: validatedItem.quantity
        }
      })

    }

    return getCart(customerId, pricingMaps)

  })

}

export async function removeItem(customerId, variantId, pricingMaps) {

  return prisma.$transaction(async (tx) => {

    const cart = await findActiveCart(customerId)

    const item = await tx.cartItem.findFirst({
      where: {
        cartId: cart.id,
        variantId
      }
    })

    if (!item) {
      throw new Error("CART_ITEM_NOT_FOUND")
    }

    await tx.cartItem.delete({
      where: { id: item.id }
    })

    return getCart(customerId, pricingMaps)

  })

}

export async function getCart(customerId, pricingMaps) {

  const cart = await findActiveCart(customerId)

  const items = await prisma.cartItem.findMany({
    where: {
      cartId: cart.id
    }
  })

  const cartItems = items.map(i => ({
    variantId: i.variantId,
    quantity: i.quantity
  }))

  return computeCart(cartItems, pricingMaps)

}