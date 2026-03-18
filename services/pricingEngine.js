/*
WinWin Cart Pricing Engine
MASTER v8 FINAL
*/

function validateQuantity(variant, quantity) {

  if (quantity < variant.moq) {
    throw new Error("MOQ_NOT_RESPECTED")
  }

  if (variant.quantityStep && quantity % variant.quantityStep !== 0) {
    throw new Error("INVALID_QUANTITY_STEP")
  }

  if (variant.quantityMax && quantity > variant.quantityMax) {
    throw new Error("QUANTITY_MAX_EXCEEDED")
  }

  if (variant.stock !== null && quantity > variant.stock) {
    return {
      adjustedQuantity: variant.stock,
      warning: "STOCK_ADJUSTED"
    }
  }

  return { adjustedQuantity: quantity }

}

function applyTierPricing(basePrice, quantity, tiers = []) {

  let price = basePrice
  let appliedTier = null

  for (const tier of tiers) {
    if (quantity >= tier.minQty) {
      price = tier.price
      appliedTier = tier
    }
  }

  return { price, appliedTier }

}

function applyPackaging(quantity, packagingList = []) {

  let optimizedQty = quantity
  let packagingApplied = null

  for (const pack of packagingList) {

    if (pack.type === "PACK") {

      const size = pack.quantity

      if (size && quantity % size !== 0) {
        optimizedQty = Math.ceil(quantity / size) * size
        packagingApplied = pack
      }

    }

  }

  return { optimizedQty, packagingApplied }

}

function applyBundlePricing(cartMap, bundleMap) {

  let totalDiscount = 0
  const bundleDetails = []

  for (const bundle of bundleMap.values()) {

    let bundleCount = Infinity

    for (const item of bundle.items) {

      const cartItem = cartMap.get(item.variantId)

      if (!cartItem) {
        bundleCount = 0
        break
      }

      const possible = Math.floor(cartItem.quantity / item.quantity)
      bundleCount = Math.min(bundleCount, possible)
    }

    if (bundleCount > 0 && bundleCount !== Infinity) {

      const discount = bundle.bundlePrice * bundleCount

      totalDiscount += discount

      bundleDetails.push({
        bundleId: bundle.id,
        count: bundleCount,
        discount
      })

    }

  }

  return { totalDiscount, bundleDetails }

}

export function computeCart(cartItems, maps) {

  const {
    variantMap,
    tierMap,
    packagingMap,
    bundleMap
  } = maps

  const cartMap = new Map()
  let cartTotal = 0
  const computedItems = []

  for (const item of cartItems) {

    const variant = variantMap.get(item.variantId)

    if (!variant) {
      throw new Error("VARIANT_NOT_FOUND")
    }

    const validation = validateQuantity(variant, item.quantity)
    const quantity = validation.adjustedQuantity

    const tiers = tierMap.get(item.variantId) || []

    const { price, appliedTier } = applyTierPricing(
      variant.priceB2B ?? variant.priceBase,
      quantity,
      tiers
    )

    const { optimizedQty, packagingApplied } = applyPackaging(
      quantity,
      packagingMap.get(item.variantId) || []
    )

    const lineTotal = price * optimizedQty
    cartTotal += lineTotal

    const cartItem = {
      variantId: item.variantId,
      quantity: optimizedQty,
      unitPrice: price,
      basePrice: variant.priceBase,
      lineTotal,
      discounts: [],
      warnings: []
    }

    if (appliedTier) {
      cartItem.discounts.push({
        type: "tier",
        description: `Palier ${appliedTier.minQty}`,
        amount: variant.priceBase - price
      })
    }

    if (packagingApplied) {
      cartItem.warnings.push({
        type: "packaging",
        description: `Quantité ajustée (${packagingApplied.quantity})`
      })
    }

    if (validation.warning) {
      cartItem.warnings.push({
        type: "stock",
        description: "Quantité ajustée au stock"
      })
    }

    cartMap.set(item.variantId, cartItem)
    computedItems.push(cartItem)

  }

  const { totalDiscount, bundleDetails } = applyBundlePricing(cartMap, bundleMap)

  cartTotal -= totalDiscount

  return {
    items: computedItems,
    bundleDiscount: totalDiscount,
    bundleDetails,
    total: cartTotal
  }

}