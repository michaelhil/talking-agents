// HTTP fetch wrappers that swallow errors and return null on failure.
// Callers that want a distinct "failed" signal use the null return; no
// caller today needs richer error info from these helpers.

export const safeFetch = async (url: string, init?: RequestInit): Promise<Response | null> => {
  try {
    const res = await fetch(url, init)
    if (!res.ok) {
      console.error(`Fetch ${init?.method ?? 'GET'} ${url} failed: ${res.status}`)
      return null
    }
    return res
  } catch (err) {
    console.error(`Fetch ${url} error:`, err)
    return null
  }
}

export const safeFetchJson = async <T>(url: string, init?: RequestInit): Promise<T | null> => {
  const res = await safeFetch(url, init)
  if (!res) return null
  try {
    return await res.json() as T
  } catch {
    return null
  }
}
