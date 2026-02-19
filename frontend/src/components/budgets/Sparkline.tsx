'use client';

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
  strokeColor?: string;
  fillColor?: string;
}

export function Sparkline({
  data,
  width = 60,
  height = 20,
  className = '',
  strokeColor = 'currentColor',
  fillColor = 'none',
}: SparklineProps) {
  if (data.length < 2) return null;

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;

  const padding = 1;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;

  const points = data.map((value, index) => {
    const x = padding + (index / (data.length - 1)) * innerWidth;
    const y = padding + innerHeight - ((value - min) / range) * innerHeight;
    return `${x},${y}`;
  });

  const linePath = `M${points.join(' L')}`;
  const areaPath = `${linePath} L${padding + innerWidth},${padding + innerHeight} L${padding},${padding + innerHeight} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
    >
      {fillColor !== 'none' && (
        <path d={areaPath} fill={fillColor} opacity={0.15} />
      )}
      <path
        d={linePath}
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
