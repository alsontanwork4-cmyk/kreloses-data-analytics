import { describe, expect, it } from "vitest";

import { isOneTimeCodePath } from "./html";

describe("isOneTimeCodePath", () => {
  it("recognises the usual one-time-code / two-factor steps", () => {
    for (const path of [
      "/Account/VerifyCode",
      "/account/sendcode?provider=Email",
      "/Account/TwoFactor",
      "/account/two-factor/",
      "/Identity/Account/LoginWith2fa",
      "/auth/2fa",
      "/otp",
      "/Account/MFA/Verify",
    ]) {
      expect(isOneTimeCodePath(new URL(path, "https://www.kreloses.com")), path).toBe(true);
    }
  });

  it("only matches whole path segments, so ordinary app pages are not mistaken for a code step", () => {
    for (const path of [
      "/HotProducts",
      "/Report/Hotpots",
      "/Sale/Overview/12345",
      "/Home/Index",
      "/Setup/MfaSettingsHelp",
      "/Stock/Otparts",
      "/Account/VerifyCodeHelp",
    ]) {
      expect(isOneTimeCodePath(new URL(path, "https://sea.kreloses.com")), path).toBe(false);
    }
  });
});
