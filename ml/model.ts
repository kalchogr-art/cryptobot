// src/ml/model.ts
// BASE V0.1 — pure math only; no DB and no trading.

export type MLFeatures = {
  score: number;
  chart: number;
  orderFlow: number;
  funding: number;
};

export type MLWeights = {
  bias: number;
  score: number;
  chart: number;
  orderFlow: number;
  funding: number;
};

export const INITIAL_WEIGHTS: MLWeights = {
  bias: 0, score: 0, chart: 0, orderFlow: 0, funding: 0
};

const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
export const sigmoid=(z:number)=>1/(1+Math.exp(-clamp(z,-20,20)));

export function predictTP(x: MLFeatures, w: MLWeights) {
  const z=w.bias+w.score*x.score+w.chart*x.chart+
          w.orderFlow*x.orderFlow+w.funding*x.funding;
  const probability=sigmoid(z);
  return { probability, prediction: probability>=0.5 ? "TP" : "NOT_TP" };
}

export function learnOne(
  x: MLFeatures, y: 0|1, w: MLWeights, learningRate=0.03
): MLWeights {
  const p=predictTP(x,w).probability;
  const e=y-p;
  return {
    bias:w.bias+learningRate*e,
    score:w.score+learningRate*e*x.score,
    chart:w.chart+learningRate*e*x.chart,
    orderFlow:w.orderFlow+learningRate*e*x.orderFlow,
    funding:w.funding+learningRate*e*x.funding
  };
}
