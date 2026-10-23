import type { SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & { size?: number };

/** A globe with a magnifier: searching the web. */
export function GlobalSearchIcon({ size = 24, ...props }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M22 12C22 6.48 17.52 2 12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22" />
      <path d="M7.99998 3H8.99998C7.04998 8.84 7.04998 15.16 8.99998 21H7.99998" />
      <path d="M15 3C15.97 5.92 16.46 8.96 16.46 12" />
      <path d="M3 16V15C5.92 15.97 8.96 16.46 12 16.46" />
      <path d="M3 9.0001C8.84 7.0501 15.16 7.0501 21 9.0001" />
      <path d="M18.2 21.4C19.9673 21.4 21.4 19.9673 21.4 18.2C21.4 16.4327 19.9673 15 18.2 15C16.4327 15 15 16.4327 15 18.2C15 19.9673 16.4327 21.4 18.2 21.4Z" />
      <path d="M22 22L21 21" />
    </svg>
  );
}
