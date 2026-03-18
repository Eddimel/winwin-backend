import fetch from "node-fetch"
import { prisma } from "../lib/prisma.js"

export async function syncShopifyCustomer(customer) {

  if (customer.status !== "APPROVED") {
    throw new Error("CUSTOMER_NOT_APPROVED")
  }

  const shop = await prisma.shop.findFirst({
    where: { isApproved: true }
  })

  if (!shop) {
    throw new Error("SHOP_NOT_FOUND")
  }

  if (customer.shopifyCustomerId) {
    return customer.shopifyCustomerId
  }

  const payload = {
    customer: {
      phone: customer.phone,
      first_name: customer.name
    }
  }

  const response = await fetch(
    `https://${shop.shop}/admin/api/2026-01/customers.json`,
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
    console.error("SHOPIFY CUSTOMER ERROR:", data)
    throw new Error("SHOPIFY_CUSTOMER_CREATE_FAILED")
  }

  const shopifyCustomerId = data.customer.id.toString()

  await prisma.customer.update({
    where: { id: customer.id },
    data: {
      shopId: shop.id,
      shopifyCustomerId
    }
  })

  return shopifyCustomerId
}