import fetch from "node-fetch"

export async function fetchWithRetry(url, options = {}, retries = 3) {

  for (let attempt = 1; attempt <= retries; attempt++) {

    try {

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)

      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      })

      clearTimeout(timeout)

      if (response.ok) {
        return response
      }

      if (
        response.status === 429 ||
        response.status >= 500
      ) {
        console.warn(`Retry ${attempt} due to status ${response.status}`)
      } else {
        return response
      }

    } catch (error) {

      console.warn(`Retry ${attempt} due to network error`, error.message)

      if (attempt === retries) {
        throw error
      }
    }

    await new Promise(r => setTimeout(r, attempt * 1000))
  }

  throw new Error("FETCH_FAILED")
}