/** 낙서형 체크 마크. 시각 SVG만 제공하고 라벨은 호출부 aria-label이 맡는다. */
export function CheckIcon() {
  return (
    <svg className="scribble-check" viewBox="0 0 95 95" aria-hidden>
      <rect
        className="scribble-check-box"
        x="30"
        y="20"
        width="50"
        height="50"
        rx="8"
        fill="none"
      />
      <g transform="translate(0,-952.36222)">
        <path
          className="scribble-check-mark"
          d="m 56,963 c -102,122 6,9 7,9 17,-5 -66,69 -38,52 122,-77 -7,14 18,4 29,-11 45,-43 23,-4"
          pathLength="400"
          fill="none"
        />
      </g>
    </svg>
  );
}
