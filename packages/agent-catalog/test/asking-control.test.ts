import { describe, expect, it } from "vitest"

import { familyAskingControl } from "../src/asking-control.js"

describe("familyAskingControl", () => {
  it("matches EnvoyCoder featured rows", () => {
    expect(familyAskingControl("envoy-harness")).toBe("policy")
    expect(familyAskingControl("cursor")).toBe("launch-force")
    expect(familyAskingControl("pi")).toBe("none")
  })

  it("defaults unknown featured ids to catalog-acp", () => {
    expect(familyAskingControl("minimax-code")).toBe("catalog-acp")
  })
})