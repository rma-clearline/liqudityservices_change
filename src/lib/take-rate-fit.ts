// Bounded, prior-anchored weighted least squares for the QTD take-rate model.
//
// Fits θ_b (revenue per SCRAPED bucket dollar — capture is absorbed, so the fit
// needs no capture assumption) against reported revenue targets:
//
//   minimize  Σ_i wᵢ (targetᵢ − Σ_b θ_b·S_{b,i})²  +  λ Σ_b s_b (θ_b − prior_b)²
//   subject to  bounds_b[0] ≤ θ_b ≤ bounds_b[1]
//
// s_b = Σᵢ wᵢ S_{b,i}² scales the ridge penalty to the data, making λ unitless:
// λ=1 balances "one observation's worth" of prior against the data; with few
// quarters the priors dominate, and each new reported quarter shifts weight to
// the data. Solved by projected coordinate descent — the system is tiny
// (~7 unknowns, ~9 equations), deterministic, and converges in a few passes.

export type FitObservation = {
  weight: number;
  target: number;
  /** Loadings per bucket (scraped GMV in USD); absent buckets contribute 0. */
  loadings: Record<string, number>;
};

export type FitResult = {
  theta: Record<string, number>;
  residuals: { target: number; predicted: number; weight: number }[];
  converged: boolean;
};

export function fitTakeRates(
  obs: FitObservation[],
  priors: Record<string, number>,
  bounds: Record<string, [number, number]>,
  lambda = 1,
): FitResult {
  const buckets = Object.keys(priors);
  const clamp = (b: string, v: number) => {
    const [lo, hi] = bounds[b] ?? [0, Number.POSITIVE_INFINITY];
    return Math.min(hi, Math.max(lo, v));
  };

  // Penalty scale per bucket; a bucket absent from every observation stays at its prior.
  const scale: Record<string, number> = {};
  for (const b of buckets) {
    scale[b] = obs.reduce((s, o) => s + o.weight * (o.loadings[b] ?? 0) ** 2, 0);
  }

  const theta: Record<string, number> = {};
  for (const b of buckets) theta[b] = clamp(b, priors[b]);

  const predict = (o: FitObservation) => buckets.reduce((s, b) => s + theta[b] * (o.loadings[b] ?? 0), 0);

  let converged = false;
  for (let pass = 0; pass < 500 && !converged; pass++) {
    let maxDelta = 0;
    for (const b of buckets) {
      if (scale[b] === 0) continue; // no data for this bucket — keep the prior
      // Optimal θ_b holding the others fixed (closed form for the 1-D quadratic).
      let num = lambda * scale[b] * priors[b];
      let den = lambda * scale[b];
      for (const o of obs) {
        const s = o.loadings[b] ?? 0;
        if (s === 0) continue;
        const partial = o.target - (predict(o) - theta[b] * s);
        num += o.weight * s * partial;
        den += o.weight * s * s;
      }
      const next = clamp(b, num / den);
      maxDelta = Math.max(maxDelta, Math.abs(next - theta[b]) / Math.max(1e-12, Math.abs(theta[b]) + 1e-6));
      theta[b] = next;
    }
    converged = maxDelta < 1e-10;
  }

  return {
    theta,
    residuals: obs.map((o) => ({ target: o.target, predicted: predict(o), weight: o.weight })),
    converged,
  };
}
