type OtpRecord = {
  code: string;
  verified: boolean;
  expiresAt: number;
};

const otpStorage = new Map<string, OtpRecord>();

const send = (phone: string): string => {
  const otpCode = "1234"; // TODO: brancher un vrai provider SMS en prod
  otpStorage.set(phone, {
    code: otpCode,
    verified: false,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return otpCode;
};

const verify = (
  phone: string,
  code: string
): { valid: boolean; reason?: "not_found" | "expired" | "invalid" } => {
  const otp = otpStorage.get(phone);
  if (!otp) return { valid: false, reason: "not_found" };
  if (Date.now() > otp.expiresAt) return { valid: false, reason: "expired" };
  if (otp.code !== code) return { valid: false, reason: "invalid" };
  otp.verified = true;
  otpStorage.set(phone, otp);
  return { valid: true };
};

const isVerified = (phone: string): boolean => otpStorage.get(phone)?.verified === true;

const clear = (phone: string): void => {
  otpStorage.delete(phone);
};

export default {
  send,
  verify,
  isVerified,
  clear,
};
