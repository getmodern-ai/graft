import { describe, expect, it } from "vitest";

import { sidebarOpenFromCookie } from "./sidebar-state";

describe("sidebarOpenFromCookie", () => {
  it("opens when nothing has been stored", () => {
    expect(sidebarOpenFromCookie("")).toBe(true);
    expect(sidebarOpenFromCookie("theme=dark")).toBe(true);
  });

  it("reads the stored state", () => {
    expect(sidebarOpenFromCookie("sidebar_state=false")).toBe(false);
    expect(sidebarOpenFromCookie("sidebar_state=true")).toBe(true);
  });

  it("finds the cookie wherever it sits in the header", () => {
    expect(sidebarOpenFromCookie("theme=dark; sidebar_state=false; other=1")).toBe(false);
    expect(sidebarOpenFromCookie("sidebar_state=false; theme=dark")).toBe(false);
  });

  // A name that merely ends in the cookie's name is a different cookie. Matching on `includes`
  // would let `my_sidebar_state=false` collapse a sidebar the person never touched.
  it("does not match a cookie whose name only ends with ours", () => {
    expect(sidebarOpenFromCookie("my_sidebar_state=false")).toBe(true);
  });

  it("does not match a cookie whose value mentions ours", () => {
    expect(sidebarOpenFromCookie("last=sidebar_state=false")).toBe(true);
  });

  // Anything that is not an explicit "false" leaves the sidebar open, so a truncated or
  // hand-edited cookie degrades to the default rather than to a collapsed shell.
  it("opens on a value it does not understand", () => {
    expect(sidebarOpenFromCookie("sidebar_state=")).toBe(true);
    expect(sidebarOpenFromCookie("sidebar_state=FALSE")).toBe(true);
    expect(sidebarOpenFromCookie("sidebar_state")).toBe(true);
  });
});
