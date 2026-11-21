/**
 * The engraved rosette behind the Classic hero, the ornament of a printed
 * statement: twenty-four ellipses turned about one centre, in the accent at
 * a fifth of its strength. Decoration only, hidden from assistive technology.
 */
const TURNS = Array.from({ length: 24 }, (_, i) => i * 7.5);

export function Guilloche({ className = '' }: { className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 520 520" className={className}>
      <g fill="none" stroke="currentColor" strokeWidth={0.7}>
        {TURNS.map((deg) => (
          <ellipse key={deg} cx={260} cy={260} rx={250} ry={92} transform={`rotate(${deg} 260 260)`} />
        ))}
      </g>
    </svg>
  );
}
