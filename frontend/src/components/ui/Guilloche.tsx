/**
 * The engraved rosette of a printed statement, the Folio style's one
 * ornament: twenty-four ellipses turned about one centre, drawn in
 * `currentColor` (the caller sets the accent at a fraction of its strength).
 * Behind the Folio dashboard hero and the Folio empty page. Decoration
 * only, hidden from assistive technology.
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
