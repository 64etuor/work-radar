/**
 * Spinner — 비동기 로딩 상태 표시 (작은 CSS 스피너).
 * 사용: <Spinner /> 또는 <Spinner size="sm" />
 */
import "./Spinner.css";

interface SpinnerProps {
  size?: "sm" | "md";
  className?: string;
}

export function Spinner({ size = "sm", className = "" }: SpinnerProps) {
  return (
    <output
      className={`spinner spinner-${size}${className ? ` ${className}` : ""}`}
      aria-label="로딩 중"
    />
  );
}
