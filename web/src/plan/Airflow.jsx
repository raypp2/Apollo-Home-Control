// Apollo v2 dashboard -- AC airflow streamlines (Beacon v3 §5.2).
//
// Four S-curved streamlines flowing down and away from the vent above them,
// each animated via `stroke-dashoffset` (see plan-ac.css's `plan-ac-flow`
// keyframe) and masked with a linear gradient so they fade out toward the
// room rather than ending in a hard edge -- a car-vent airflow feel. This
// component is only ever mounted while the AC is on; AcVent.jsx owns that
// decision and unmounting it is what stops the animation.
//
// `--flow-len` (a CSS custom property set per-path below) is the exact sum
// of each path's dasharray (dash + gap), so the keyframe's `to` value
// completes one full pattern cycle and loops back to `from` seamlessly --
// no visible jump at the animation restart.

const STREAMS = [
  { d: 'M20,2 C10,25 35,35 22,55 S5,80 12,98', dash: '16 44', flowLen: '60px', duration: '2.3s', delay: '0s', opacity: 0.55 },
  { d: 'M35,2 C45,20 20,40 30,60 S45,85 38,98', dash: '20 46', flowLen: '66px', duration: '2.7s', delay: '-0.6s', opacity: 0.42 },
  { d: 'M55,2 C65,22 42,42 52,62 S68,86 60,98', dash: '18 45', flowLen: '63px', duration: '2.1s', delay: '-1.2s', opacity: 0.48 },
  { d: 'M70,2 C80,25 55,35 68,55 S85,80 78,98', dash: '22 48', flowLen: '70px', duration: '3s', delay: '-1.8s', opacity: 0.4 },
];

export default function Airflow() {
  return (
    <svg
      class="plan-ac-airflow"
      viewBox="0 0 90 100"
      width="90"
      height="100"
      style={{
        position: 'absolute',
        left: '50%',
        top: '100%',
        transform: 'translateX(-50%)',
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      {STREAMS.map((s, i) => (
        <path
          key={i}
          d={s.d}
          class="plan-ac-airflow__stream"
          fill="none"
          stroke={`rgba(120,185,255,${s.opacity})`}
          stroke-width="1.3"
          stroke-linecap="round"
          style={{
            strokeDasharray: s.dash,
            '--flow-len': s.flowLen,
            animation: `plan-ac-flow ${s.duration} linear infinite`,
            animationDelay: s.delay,
          }}
        />
      ))}
    </svg>
  );
}
