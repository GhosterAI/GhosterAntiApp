import { expect, test } from "bun:test";
import { buildNewProfile } from "./create.ts";
import { deriveFingerprintFlags, generateProfileHardware } from "./fingerprint.ts";
import { parseExport, serializeAdsTxt, serializeXlsxRows } from "./parse.ts";
import { decodePortableProfile, encodePortableProfile } from "./portable-profile.ts";
import { ProfileStore } from "./store.ts";

const cloakProfile = () => {
  const profile = buildNewProfile({ chromiumRuntime: "cloakbrowser" }, () => false);
  return { ...profile, hardware: profile.hardware! };
};

test("a new CloakBrowser profile stores its processor cores and reports them on every launch", () => {
  const profile = cloakProfile();
  expect([8, 12, 16, 20, 24]).toContain(profile.hardware.cores);
  expect(generateProfileHardware(profile.fingerprintSeed)).toEqual(generateProfileHardware(profile.fingerprintSeed));
  expect(deriveFingerprintFlags(profile)).toContain(`--fingerprint-hardware-concurrency=${profile.hardware.cores}`);

  // Profiles differ: many seeds must not all give one value.
  const counts = new Set(Array.from({ length: 200 }, (_, seed) => generateProfileHardware(seed * 7919 + 1).cores));
  expect(counts.size).toBeGreaterThan(3);
});

test("profiles made before stored hardware, Chromium 155 profiles and Firefox profiles get no cores flag", () => {
  const { hardware: _hardware, ...legacy } = cloakProfile();
  expect(deriveFingerprintFlags(legacy).some((flag) => flag.startsWith("--fingerprint-hardware-concurrency"))).toBe(false);
  const beta = buildNewProfile({ chromiumRuntime: "ghosteranti" }, () => false);
  expect(beta.hardware).toBeUndefined();
  expect(deriveFingerprintFlags(beta).some((flag) => flag.startsWith("--fingerprint-hardware-concurrency"))).toBe(false);
  expect(buildNewProfile({ engine: "firefox" }, () => false).hardware).toBeUndefined();
});

test("stored hardware survives edits and cannot change in place", () => {
  const store = new ProfileStore(":memory:");
  const profile = cloakProfile();
  store.upsertProfile(profile);
  expect(store.getProfile(profile.id)!.hardware).toEqual(profile.hardware);

  const { hardware: _hardware, ...edited } = store.getProfile(profile.id)!;
  store.upsertProfile({ ...edited, name: "renamed" });
  expect(store.getProfile(profile.id)).toMatchObject({ name: "renamed", hardware: profile.hardware });
  expect(() => store.upsertProfile({ ...store.getProfile(profile.id)!, hardware: { cores: profile.hardware.cores + 4 } }))
    .toThrow("profile hardware cannot change in place");

  // A profile from before this field keeps the engine default; an edit cannot add hardware later.
  const { hardware: _dropped, ...legacy } = cloakProfile();
  store.upsertProfile(legacy);
  expect(store.getProfile(legacy.id)!.hardware).toBeUndefined();
  expect(() => store.upsertProfile({ ...store.getProfile(legacy.id)!, hardware: { cores: 16 } }))
    .toThrow("profile hardware cannot change in place");
  expect(() => store.upsertProfile({ ...cloakProfile(), hardware: { cores: 0 } })).toThrow("unsupported profile hardware");
  expect(() => store.upsertProfile({ ...buildNewProfile({ chromiumRuntime: "ghosteranti" }, () => false), hardware: { cores: 8 } }))
    .toThrow("only CloakBrowser profiles carry stored hardware");
  store.close();
});

test("Cloud carries stored hardware in schema V4, which older clients reject", () => {
  const profile = cloakProfile();
  const payload = encodePortableProfile(profile);
  expect(payload.schemaVersion).toBe(4);
  expect(payload.profile).toMatchObject({ hardware: profile.hardware });
  expect(decodePortableProfile(payload).profile.hardware).toEqual(profile.hardware);

  // The version and the content must agree in both directions.
  expect(() => decodePortableProfile({ ...payload, schemaVersion: 1 } as any)).toThrow("unsupported portable profile payload");
  const { hardware: _hardware, ...withoutHardware } = payload.profile as any;
  expect(() => decodePortableProfile({ ...payload, profile: withoutHardware } as any)).toThrow("unsupported portable profile payload");
  expect(() => decodePortableProfile({ ...payload, profile: { ...payload.profile, hardware: { cores: "8" } } } as any))
    .toThrow("unsupported portable profile payload");
});

test("export and import keep stored hardware", () => {
  const profile = cloakProfile();
  const { hardware: _hardware, ...legacy } = cloakProfile();
  const text = serializeAdsTxt([profile, legacy]);
  expect(text.match(/^hardware_cores=\d+$/gm)).toHaveLength(1);
  const imported = parseExport(text).profiles;
  expect(imported.find((item) => item.id === profile.id)?.hardware).toEqual(profile.hardware);
  expect(imported.find((item) => item.id === legacy.id)?.hardware).toBeUndefined();
  expect(serializeXlsxRows([profile]).headers).toContain("hardware_cores");
  expect(serializeXlsxRows([legacy]).headers).not.toContain("hardware_cores");
});

test("the profile edit view shows the stored graphics card and cores", async () => {
  const { handleUiRequest } = await import("./ui.ts");
  const store = new ProfileStore(":memory:");
  const cloak = cloakProfile();
  const firefox = buildNewProfile({ engine: "firefox", platformOs: "windows" }, () => false);
  const { hardware: _hardware, ...legacy } = cloakProfile();
  // A macOS profile saved with an Intel Mac's card, which its browser shows as Apple's.
  const mac = buildNewProfile({ engine: "firefox", platformOs: "macos" }, () => false);
  mac.firefox!.config["webGl:vendor"] = "Intel Inc.";
  mac.firefox!.config["webGl:renderer"] = "Intel(R) HD Graphics 400, or similar";
  for (const profile of [cloak, firefox, legacy, mac]) store.upsertProfile(profile);
  const view = async (id: string) =>
    (await (await handleUiRequest(new Request(`http://x/ui/api/profiles/${id}`), {} as any, store))!.json()).profile;

  expect((await view(cloak.id)).hardware).toEqual({ cores: cloak.hardware.cores });
  expect((await view(firefox.id)).hardware).toEqual({
    gpu: firefox.firefox!.config["webGl:renderer"],
    cores: firefox.firefox!.config["navigator.hardwareConcurrency"],
  });
  expect((await view(mac.id)).hardware.gpu).toBe("Apple M1, or similar");
  // Nothing is stored for a profile from before this field, so the dialog keeps "Automatic".
  expect((await view(legacy.id)).hardware).toBeUndefined();
  store.close();
});
