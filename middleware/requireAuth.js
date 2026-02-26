import { prisma } from "../lib/prisma.js"

export const requireAuth = async (req, res, next) => {
  try {
    const sessionId = req.cookies.session_id

    if (!sessionId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const session = await prisma.customerSession.findUnique({
      where: { id: sessionId },
      include: { customer: true }
    })

    if (!session || !session.isActive) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const now = Date.now()

    // 🔒 Expiration fixe : 30 jours max
    const maxLifetime = 30 * 24 * 60 * 60 * 1000
    const sessionAge = now - new Date(session.createdAt).getTime()

    if (sessionAge > maxLifetime) {
      await prisma.customerSession.update({
        where: { id: session.id },
        data: { isActive: false }
      })

      res.clearCookie("session_id", {
        httpOnly: true,
        secure: false,
        sameSite: "lax"
      })

      return res.status(401).json({ error: "Session expired" })
    }

    // 🔒 Expiration par inactivité : 7 jours
    const inactivityLimit = 7 * 24 * 60 * 60 * 1000
    const lastUsed = new Date(session.lastUsedAt || session.createdAt).getTime()
    const inactivityDuration = now - lastUsed

    if (inactivityDuration > inactivityLimit) {
      await prisma.customerSession.update({
        where: { id: session.id },
        data: { isActive: false }
      })

      res.clearCookie("session_id", {
        httpOnly: true,
        secure: false,
        sameSite: "lax"
      })

      return res.status(401).json({ error: "Session expired due to inactivity" })
    }

    // 🔄 Mise à jour lastUsedAt
    await prisma.customerSession.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() }
    })

    req.customer = session.customer
    req.session = session

    next()

  } catch (error) {
    console.error("Auth middleware error:", error)
    return res.status(500).json({ error: "Server error" })
  }
}