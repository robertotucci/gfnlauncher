import { describe, expect, it } from 'vitest'
import { isApiRequest, readVpcId, readVpcIdFromUrl } from './webAuth'

function body(text: string): Electron.UploadData[] {
  return [{ bytes: Buffer.from(text, 'utf8') } as Electron.UploadData]
}

describe('readVpcId', () => {
  it('reads it from a JSON envelope', () => {
    expect(readVpcId(body(JSON.stringify({ variables: { vpcId: 'NP-EU-WEST' } })))).toBe(
      'NP-EU-WEST'
    )
  })

  it('reads it inlined in a raw GraphQL document', () => {
    // The client sometimes posts the document itself rather than a JSON
    // envelope; looking only for JSON missed every request on a real session.
    expect(readVpcId(body('query { apps(vpcId: "NP-EU-WEST", language: "en_US") { id } }'))).toBe(
      'NP-EU-WEST'
    )
  })

  it('handles single quotes', () => {
    expect(readVpcId(body("{ apps(vpcId: 'ZONE-1') { id } }"))).toBe('ZONE-1')
  })

  it('ignores an empty vpcId rather than capturing a blank zone', () => {
    expect(readVpcId(body(JSON.stringify({ variables: { vpcId: '' } })))).toBeNull()
  })

  it('returns null when the body has no vpcId', () => {
    expect(readVpcId(body(JSON.stringify({ variables: { locale: 'en_US' } })))).toBeNull()
  })

  it('tolerates a body with no readable bytes', () => {
    expect(readVpcId([{ blobUUID: 'abc' } as Electron.UploadData])).toBeNull()
    expect(readVpcId(undefined)).toBeNull()
  })

  it('scans every part of a multi-part body', () => {
    expect(
      readVpcId([
        { bytes: Buffer.from('prelude') } as Electron.UploadData,
        { bytes: Buffer.from('{"variables":{"vpcId":"Z9"}}') } as Electron.UploadData
      ])
    ).toBe('Z9')
  })
})

describe('isApiRequest', () => {
  it('accepts a GraphQL call', () => {
    expect(isApiRequest('https://apps.gxn.nvidia.com/graphql?requestType=panels')).toBe(true)
  })

  it('accepts GraphQL over GET', () => {
    expect(isApiRequest('https://apps.gxn.nvidia.com/graphql?variables=%7B%7D')).toBe(true)
  })

  it('refuses the identity endpoint', () => {
    // login.nvidia.com/userinfo carries a perfectly valid bearer that is 401
    // everywhere else — accepting it is what produced the earlier failures.
    expect(isApiRequest('https://login.nvidia.com/userinfo')).toBe(false)
  })

  it('refuses telemetry and experiment services', () => {
    expect(isApiRequest('https://events.telemetry.data.nvidia.com/v1.0/events/json')).toBe(false)
    expect(isApiRequest('https://prod.otel.kaizen.nvidia.com/traces/otlp/v0.9')).toBe(false)
    expect(isApiRequest('https://gx-target-survey-frontend-api.gx.nvidia.com/x')).toBe(false)
  })

  it('refuses a malformed url instead of throwing', () => {
    expect(isApiRequest('not a url')).toBe(false)
  })
})

describe('readVpcIdFromUrl', () => {
  it('reads a direct query parameter', () => {
    expect(readVpcIdFromUrl('https://x/graphql?vpcId=NP-EU-WEST')).toBe('NP-EU-WEST')
  })

  it('reads it out of a JSON variables parameter', () => {
    const url = `https://x/graphql?variables=${encodeURIComponent('{"vpcId":"Z9"}')}`
    expect(readVpcIdFromUrl(url)).toBe('Z9')
  })

  it('returns null when absent or unparseable', () => {
    expect(readVpcIdFromUrl('https://x/graphql')).toBeNull()
    expect(readVpcIdFromUrl('https://x/graphql?variables=not-json')).toBeNull()
    expect(readVpcIdFromUrl('nonsense')).toBeNull()
  })
})
