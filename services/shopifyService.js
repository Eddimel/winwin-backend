/*
WinWin Shopify Service
DraftOrder Builder
MASTER v8 FIXED
*/

import fetch from "node-fetch"
import { fetchWithRetry } from "./fetchWithRetry.js"
import { prisma } from "../lib/prisma.js"

export async function createDraftOrder(customer, cart, pricingMaps) {

  const { variantMap } = pricingMaps

  const shop = await prisma.shop.findFirst({
    where: { isApproved: true }
  })

  if (!shop) {
    throw new Error("SHOP_NOT_FOUND")
  }

  const lineItems = cart.items.map(item => {

    const variant = variantMap.get(item.variantId)

    if (!variant || !variant.shopifyVariantId) {
      throw new Error("SHOPIFY_VARIANT_NOT_FOUND")
    }

    return {
      variant_id: variant.shopifyVariantId, // ✅ FIX
      quantity: item.quantity,
      price: item.basePrice.toString()
    }

  })

  // 🔥 DISCOUNT GLOBAL
  let totalDiscount = 0

  for (const item of cart.items) {
    if (item.discounts?.length) {
      for (const d of item.discounts) {
        totalDiscount += d.amount || 0
      }
    }
  }

  const payload = {
    draft_order: {
      line_items: lineItems,
      use_customer_default_address: true,
      note: "WinWin B2B Order",
      tags: "winwin,b2b",
      applied_discount: totalDiscount > 0 ? {
        description: "Remise B2B",
        value: totalDiscount.toFixed(2),
        value_type: "fixed_amount",
        amount: totalDiscount.toFixed(2),
        title: "Remise WinWin"
      } : undefined
    }
  }

  const response = await fetchWithRetry(
    `https://${shop.shop}/admin/api/2026-01/draft_orders.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": shop.accessToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  )

  const data = await response.json()

  if (!response.ok) {
    console.error("SHOPIFY ERROR:", data)
    throw new Error("SHOPIFY_DRAFT_ERROR")
  }

  return data.draft_order
}