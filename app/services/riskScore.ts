export interface RiskThresholds {
  flagScore?: number;
  rejectScore?: number;
  maxEntriesPerIp?: number;
  maxEntriesPerFingerprint?: number;
  minSubmitSeconds?: number;
}

export const DEFAULT_RISK_THRESHOLDS: Required<RiskThresholds> = {
  flagScore: 40,
  rejectScore: 80,
  maxEntriesPerIp: 5,
  maxEntriesPerFingerprint: 1,
  minSubmitSeconds: 3,
};

export interface RiskEvaluationSignals {
  fingerprintCountInDraw?: number;
  ipCountInDraw?: number;
  isDatacenterOrVpn?: boolean;
  isDisposableEmail?: boolean;
  accountAgeHours?: number | null;
  submitDurationSeconds?: number | null;
  geoCountryMismatch?: boolean;
  addressReuseCountInDraw?: number;
}

export interface RiskEvaluationResult {
  score: number;
  flags: string[];
  status: "VALID" | "FLAGGED" | "REJECTED";
  action: "ACCEPT" | "FLAG_FOR_REVIEW" | "REJECT";
  reasonSummary: string;
}

/**
 * Evaluates comprehensive anti-bot and fraud signals into a 0-100 risk score,
 * identifying suspicious patterns without hard-blocking IPs (to protect shared households and mobile carriers).
 */
export function calculateRiskScore(
  signals: RiskEvaluationSignals,
  customThresholds?: RiskThresholds | null
): RiskEvaluationResult {
  const thresholds: Required<RiskThresholds> = {
    ...DEFAULT_RISK_THRESHOLDS,
    ...customThresholds,
  };

  let score = 0;
  const flags: string[] = [];

  // 1. Device Fingerprint Reuse (> maxEntriesPerFingerprint, default: 1)
  const fpCount = signals.fingerprintCountInDraw ?? 0;
  if (fpCount >= thresholds.maxEntriesPerFingerprint) {
    score += 45;
    flags.push("FINGERPRINT_REUSE");
  }

  // 2. IP Reuse (> maxEntriesPerIp, default: 5)
  // Note: We do NOT hard block on IP alone because households and mobile carriers legitimately share IPs
  const ipCount = signals.ipCountInDraw ?? 0;
  if (ipCount >= thresholds.maxEntriesPerIp) {
    score += 25;
    flags.push("IP_REUSE");
  }

  // 3. Datacenter, VPN, or Hosting IP ASN
  if (signals.isDatacenterOrVpn) {
    score += 40;
    flags.push("DATACENTER_OR_VPN_IP");
  }

  // 4. Disposable or temporary email domain
  if (signals.isDisposableEmail) {
    score += 50;
    flags.push("DISPOSABLE_EMAIL");
  }

  // 5. Very new customer account (< 24 hours)
  if (signals.accountAgeHours !== null && signals.accountAgeHours !== undefined && signals.accountAgeHours < 24) {
    score += 25;
    flags.push("VERY_NEW_ACCOUNT");
  }

  // 6. Very fast submit (between minSubmitSeconds and 5 seconds)
  if (
    signals.submitDurationSeconds !== null &&
    signals.submitDurationSeconds !== undefined &&
    signals.submitDurationSeconds >= thresholds.minSubmitSeconds &&
    signals.submitDurationSeconds < 5
  ) {
    score += 20;
    flags.push("VERY_FAST_SUBMIT");
  }

  // 7. Geo IP Country != Customer Shipping Country
  if (signals.geoCountryMismatch) {
    score += 20;
    flags.push("GEO_IP_MISMATCH");
  }

  // 8. Shared address hash in the draw
  const addrReuse = signals.addressReuseCountInDraw ?? 0;
  if (addrReuse > 0) {
    score += 35;
    flags.push("SHARED_ADDRESS");
  }

  const finalScore = Math.min(100, score);

  let status: "VALID" | "FLAGGED" | "REJECTED";
  let action: "ACCEPT" | "FLAG_FOR_REVIEW" | "REJECT";
  let reasonSummary: string;

  if (finalScore >= thresholds.rejectScore) {
    status = "REJECTED";
    action = "REJECT";
    reasonSummary = `High risk detected (Score ${finalScore} >= ${thresholds.rejectScore}). Entry rejected.`;
  } else if (finalScore >= thresholds.flagScore) {
    status = "FLAGGED";
    action = "FLAG_FOR_REVIEW";
    reasonSummary = `Moderate risk signals detected (Score ${finalScore} >= ${thresholds.flagScore}). Flagged for merchant approval.`;
  } else {
    status = "VALID";
    action = "ACCEPT";
    reasonSummary = `Normal risk evaluation (Score ${finalScore} < ${thresholds.flagScore}). Entry accepted.`;
  }

  return {
    score: finalScore,
    flags,
    status,
    action,
    reasonSummary,
  };
}
