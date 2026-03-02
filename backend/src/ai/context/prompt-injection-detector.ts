/**
 * Detects common prompt injection patterns in user queries.
 *
 * Returns a risk assessment that can be used to decide whether to
 * block the query or add extra defenses. This is a heuristic-based
 * classifier -- it catches known attack patterns but cannot guarantee
 * detection of all prompt injection attempts.
 */

export interface InjectionRiskAssessment {
  riskLevel: "low" | "medium" | "high";
  matchedPatterns: string[];
}

const HIGH_RISK_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  {
    pattern: /ignore\s+(all\s+)?previous\s+instructions/i,
    label: "instruction_override",
  },
  {
    pattern:
      /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|guidelines)/i,
    label: "instruction_override",
  },
  {
    pattern:
      /forget\s+(all\s+)?(previous|prior|your)\s+(instructions|rules|guidelines)/i,
    label: "instruction_override",
  },
  {
    pattern:
      /override\s+(system|safety|security)\s+(prompt|instructions|rules)/i,
    label: "system_override",
  },
  {
    pattern: /\bsystem\s*prompt\b/i,
    label: "system_prompt_extraction",
  },
  {
    pattern:
      /reveal\s+(your|the|all)\s+(instructions|system\s*prompt|rules|guidelines|secrets)/i,
    label: "system_prompt_extraction",
  },
  {
    pattern:
      /show\s+(me\s+)?(your|the)\s+(full\s+)?(system\s*prompt|instructions|rules)/i,
    label: "system_prompt_extraction",
  },
  {
    pattern:
      /output\s+(the|your)\s+(full\s+)?(system\s*prompt|instructions|hidden|secret)/i,
    label: "system_prompt_extraction",
  },
  {
    pattern: /act\s+as\s+(a\s+)?(different|new|debugging|unrestricted)/i,
    label: "role_hijacking",
  },
  {
    pattern: /you\s+are\s+now\s+(a\s+)?/i,
    label: "role_hijacking",
  },
  {
    pattern: /pretend\s+(you\s+are|to\s+be)\s+(a\s+)?/i,
    label: "role_hijacking",
  },
  {
    pattern: /from\s+now\s+on[\s,]+/i,
    label: "behavioral_change",
  },
  {
    pattern: /new\s+(instructions|rules|mode)\s*:/i,
    label: "behavioral_change",
  },
];

const MEDIUM_RISK_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> =
  [
    {
      pattern: /\bdo\s+not\s+follow\b/i,
      label: "instruction_suppression",
    },
    {
      pattern: /\bskip\s+(the\s+)?(rules|restrictions|limitations|filters)\b/i,
      label: "instruction_suppression",
    },
    {
      pattern:
        /\b(individual|specific)\s+transaction\s+(details|data|amounts|records)\b/i,
      label: "data_extraction",
    },
    {
      pattern: /\braw\s+(data|json|output|response)\b/i,
      label: "data_extraction",
    },
    {
      pattern: /\btool\s+call\s+(results?|output|data)\b/i,
      label: "tool_result_extraction",
    },
    {
      pattern:
        /\blist\s+(all|every|each)\s+(individual\s+)?(transaction|payee|payment)/i,
      label: "individual_data_request",
    },
    {
      pattern: /\b(jailbreak|prompt\s*inject|bypass\s+filter)\b/i,
      label: "explicit_attack",
    },
  ];

/**
 * Assess the prompt injection risk of a user query.
 *
 * Returns an assessment with the highest risk level matched
 * and the list of pattern labels that triggered.
 */
export function assessInjectionRisk(query: string): InjectionRiskAssessment {
  const matchedPatterns: string[] = [];
  let riskLevel: "low" | "medium" | "high" = "low";

  for (const { pattern, label } of HIGH_RISK_PATTERNS) {
    if (pattern.test(query)) {
      riskLevel = "high";
      if (!matchedPatterns.includes(label)) {
        matchedPatterns.push(label);
      }
    }
  }

  if (riskLevel !== "high") {
    for (const { pattern, label } of MEDIUM_RISK_PATTERNS) {
      if (pattern.test(query)) {
        riskLevel = "medium";
        if (!matchedPatterns.includes(label)) {
          matchedPatterns.push(label);
        }
      }
    }
  }

  return { riskLevel, matchedPatterns };
}
