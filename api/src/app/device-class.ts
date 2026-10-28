/**
 * Device classes (migration 019): a licence counts desktops (the Windows app) against
 * `license_keys.max_machines` and phones (the Android field app) against
 * `license_keys.max_mobile_devices`. A fingerprint keeps the class it was activated with.
 */
import { z } from "zod";

export const DEVICE_CLASSES = ["desktop", "mobile"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];
export const DeviceClassSchema = z.enum(DEVICE_CLASSES);

/**
 * Class of a device request that carries no `device_class`. Every desktop released before the
 * mobile app sends none, so such a request is a desktop; the mobile app always sends "mobile".
 */
export const DEVICE_CLASS_WHEN_ABSENT: DeviceClass = "desktop";

export function requestedDeviceClass(value: DeviceClass | undefined): DeviceClass {
  return value ?? DEVICE_CLASS_WHEN_ABSENT;
}

/** Bounds of `license_keys.max_mobile_devices` (CHECK of migration 019). 0 = mobile not licensed. */
export const MAX_MOBILE_DEVICES_MIN = 0;
export const MAX_MOBILE_DEVICES_MAX = 1000;
export const MaxMobileDevicesSchema = z.number().int().min(MAX_MOBILE_DEVICES_MIN).max(MAX_MOBILE_DEVICES_MAX);

export type LicenceSlotLimits = { max_machines: number; max_mobile_devices: number };

/** Slots of one class on a licence. */
export function slotLimitFor(lic: LicenceSlotLimits, deviceClass: DeviceClass): number {
  return deviceClass === "mobile" ? lic.max_mobile_devices : lic.max_machines;
}

/** Name of the licence column that limits a class (used in error bodies). */
export function slotLimitField(deviceClass: DeviceClass): "max_machines" | "max_mobile_devices" {
  return deviceClass === "mobile" ? "max_mobile_devices" : "max_machines";
}

/** 409 body when a fingerprint is presented with a class other than its activation's. */
export function deviceClassMismatchBody(activationClass: DeviceClass, requested: DeviceClass): Record<string, unknown> {
  return {
    error: "device_class_mismatch",
    message: `This device is activated as ${activationClass}; it cannot be used as ${requested}.`,
    device_class: activationClass,
    requested_device_class: requested,
  };
}

/** 403 body when a phone activates on a licence with no mobile devices. */
export const MOBILE_NOT_LICENSED_BODY = {
  error: "mobile_not_licensed",
  message: "This licence does not include mobile devices. Ask your vendor to add mobile devices to the licence.",
  device_class: "mobile",
  max_mobile_devices: 0,
} as const;
