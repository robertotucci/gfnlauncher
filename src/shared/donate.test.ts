import { describe, expect, it } from 'vitest'
import { DONATION_URL } from './donate'

/**
 * This is the one string in the launcher that sends someone else's money
 * somewhere. A typo, a bad merge or a copied-in link from a search result would
 * redirect it silently: the QR encodes whatever it is given, and nobody
 * proofreads a matrix of black squares. These assertions are the proofreading.
 */
describe('DONATION_URL', () => {
  it('is https, so the code cannot be pointed at a plaintext redirect', () => {
    expect(new URL(DONATION_URL).protocol).toBe('https:')
  })

  it('points at PayPal itself and not at a shortener or a lookalike host', () => {
    expect(new URL(DONATION_URL).hostname).toBe('www.paypal.com')
  })

  it('carries the hosted button id, without which the page has nothing to pay', () => {
    const id = new URL(DONATION_URL).searchParams.get('hosted_button_id')
    expect(id).toBe('6TJMUEWLPE95Y')
  })
})
