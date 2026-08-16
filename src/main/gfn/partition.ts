import { session as electronSession, type Session } from 'electron'

/**
 * The browser partition the hosted GFN login lives in.
 *
 * Its own module so both the capture (webAuth) and the API client (graphql)
 * can reach it without importing each other.
 */
export const GFN_PARTITION = 'persist:gfn-session'

export function getAuthSession(): Session {
  return electronSession.fromPartition(GFN_PARTITION)
}
