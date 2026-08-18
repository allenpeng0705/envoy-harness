import { describe, it, expect } from 'vitest'
import { VERSION } from '../src/index.js'

describe('envoy-harness', () => {
  it('exports a VERSION', () => {
    expect(VERSION).toBe('0.0.0')
  })
})
