// Detection, warning and mitigation, as they enter the deep-future impact
// events. Design assumptions, documented and labelled as such:
// - Detection: an impactor of diameter D is known in advance with the survey
//   completeness for that size and year (flux.ts completenessAt), lower for worlds
//   away from Earth's surveys (Mars ×0.5; the outer system's comets ×0.2 until
//   in-space industry builds local surveys).
// - Warning: a known object gives decades of notice (drawn 5–60 years); an
//   unknown one none.
// - Mitigation: a deflection succeeds when warning ≥ 5 years and D is within the
//   capability of the era: kinetic impactors (DART, 2022: Dimorphos's period
//   shortened by about 33 minutes; Daly et al. 2023 and Thomas et al. 2023, Nature 616) to ≈ 300 m from
//   2040; ≈ 2 km once in-space industry exists; ≈ 20 km with fusion propulsion.
//   Success probability 0.9 inside the capability.
// - Evacuation: with ≥ 1 year of warning and no deflection, deaths fall to 5% of
//   the unwarned toll; property is still lost.

import { completenessAt } from './flux.ts';

export interface Capability { maxDiameterM: number; surveyBoost: number; label: string }

export function capability(has: (tech: string) => boolean): Capability {
  if (has('fusionDrive')) return { maxDiameterM: 20000, surveyBoost: 0.8, label: 'fusion-propelled deflection, system-wide surveys' };
  if (has('asteroidMining')) return { maxDiameterM: 2000, surveyBoost: 0.5, label: 'in-space industry: heavy kinetic and gravity-tractor deflection' };
  return { maxDiameterM: 300, surveyBoost: 0, label: 'DART-class kinetic impactors from Earth' };
}

export interface DefenseOutcome { detected: boolean; warningYears: number; deflected: boolean; evacuated: boolean; note: string }

/** u: four uniforms (detection, warning, deflection success, unused). `region`: 0 Earth/Moon, 1 Mars and the belt, 2 outer system, 3 another star. */
export function defend(D: number, year: number, region: number, cap: Capability, u: [number, number, number], catalogued = false): DefenseOutcome {
  const regionFactor = [1, 0.5, 0.2, 0.05][region] ?? 0.05;
  const pDetect = catalogued ? 1 : completenessAt(D, year, cap.surveyBoost) * (region === 0 ? 1 : Math.min(1, regionFactor + cap.surveyBoost * 0.6));
  const detected = u[0] < pDetect;
  if (!detected) return { detected: false, warningYears: 0, deflected: false, evacuated: false, note: 'Not detected before impact: no warning.' };
  const warning = 5 + 55 * u[1];
  const can = D <= cap.maxDiameterM && warning >= 5 && region < 3;
  const deflected = can && u[2] < 0.9;
  return {
    detected, warningYears: warning, deflected, evacuated: !deflected,
    note: deflected ? `Detected ≈ ${warning.toFixed(0)} years ahead and deflected (${cap.label}).` : can ? 'Deflection attempted and failed; the area was evacuated.' : `Too large for this era's deflection (${cap.label}); the area was evacuated.`,
  };
}
