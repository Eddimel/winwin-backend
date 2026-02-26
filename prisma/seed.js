import { prisma } from "../lib/prisma.js"

async function main() {
  console.log("Seeding Phase 2 products (adjust test)...")

  await prisma.product.deleteMany()

  await prisma.product.createMany({
    data: [
      {
        sku: "IP17-DEMO",
        name: "iPhone 17 Demo",
        description: "Produit test catalogue",
        stock: 50,
        moq: 5,
        quantityMax: 100
      },
      {
        sku: "PS5-PORTAL-DEMO",
        name: "PS5 Portal Demo",
        description: "Produit test B2B",
        stock: 30,
        moq: 3,
        quantityMax: 10
      },
      {
        sku: "VR-HEADSET-DEMO",
        name: "VR Headset Demo",
        description: "Produit test VR",
        stock: 15,
        moq: 2,
        quantityMax: 5
      }
    ]
  })

  console.log("Seed completed.")
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })