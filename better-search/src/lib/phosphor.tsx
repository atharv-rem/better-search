// Phosphor icons (phosphoricons.com), as their SVG files in src/assets/icons:
// only the icons this app uses, in only the weights it uses. Phosphor's React
// package ships all six weights of every icon it's asked for, which made it a
// quarter of the bundle.
//
// To add one, copy its SVG from @phosphor-icons/core (assets/<weight>/) into
// src/assets/icons, keeping its file name, and export it below.
import { forwardRef, type ForwardRefExoticComponent, type RefAttributes, type SVGProps } from "react";

export type IconWeight = "regular" | "duotone" | "fill";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "ref" | "children"> {
  size?: number | string;
  color?: string;
  /** Falls back to regular for a weight this icon has no file for. */
  weight?: IconWeight;
}

export type Icon = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

// Each file's contents, bundled as text by Vite, by file name.
const files = import.meta.glob<string>("../assets/icons/*.svg", { query: "?raw", import: "default", eager: true });

/** What's inside a file's <svg> element: its paths. */
function shapes(file: string) {
  const svg = files[`../assets/icons/${file}.svg`];
  return svg?.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));
}

/** `name` is the file name, as Phosphor names it: "file-pdf" for file-pdf.svg
 *  and file-pdf-duotone.svg. */
function icon(name: string): Icon {
  const weights = { regular: shapes(name), duotone: shapes(`${name}-duotone`), fill: shapes(`${name}-fill`) };
  const fallback = weights.regular ?? weights.duotone ?? weights.fill ?? "";
  const component = forwardRef<SVGSVGElement, IconProps>(
    ({ size = "1em", color = "currentColor", weight = "regular", ...props }, ref) => (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 256 256"
        width={size}
        height={size}
        fill={color}
        {...props}
        dangerouslySetInnerHTML={{ __html: weights[weight] ?? fallback }}
      />
    )
  );
  component.displayName = name;
  return component;
}

export const AppWindowIcon = icon("app-window");
export const ArrowClockwiseIcon = icon("arrow-clockwise");
export const ArrowCounterClockwiseIcon = icon("arrow-counter-clockwise");
export const ArrowSquareOutIcon = icon("arrow-square-out");
export const ArrowsClockwiseIcon = icon("arrows-clockwise");
export const CaretDownIcon = icon("caret-down");
export const CheckIcon = icon("check");
export const ClockCounterClockwiseIcon = icon("clock-counter-clockwise");
export const DiscIcon = icon("disc");
export const DownloadSimpleIcon = icon("download-simple");
export const FileIcon = icon("file");
export const FileAudioIcon = icon("file-audio");
export const FileCIcon = icon("file-c");
export const FileCSharpIcon = icon("file-c-sharp");
export const FileCodeIcon = icon("file-code");
export const FileCppIcon = icon("file-cpp");
export const FileCssIcon = icon("file-css");
export const FileCsvIcon = icon("file-csv");
export const FileDocIcon = icon("file-doc");
export const FileHtmlIcon = icon("file-html");
export const FileImageIcon = icon("file-image");
export const FileJpgIcon = icon("file-jpg");
export const FileJsIcon = icon("file-js");
export const FileJsxIcon = icon("file-jsx");
export const FileMagnifyingGlassIcon = icon("file-magnifying-glass");
export const FileMdIcon = icon("file-md");
export const FilePdfIcon = icon("file-pdf");
export const FilePngIcon = icon("file-png");
export const FilePptIcon = icon("file-ppt");
export const FilePyIcon = icon("file-py");
export const FileRsIcon = icon("file-rs");
export const FileSqlIcon = icon("file-sql");
export const FileSvgIcon = icon("file-svg");
export const FileTextIcon = icon("file-text");
export const FileTsIcon = icon("file-ts");
export const FileTsxIcon = icon("file-tsx");
export const FileTxtIcon = icon("file-txt");
export const FileVideoIcon = icon("file-video");
export const FileXlsIcon = icon("file-xls");
export const FileZipIcon = icon("file-zip");
export const FolderIcon = icon("folder");
export const FolderOpenIcon = icon("folder-open");
export const GearSixIcon = icon("gear-six");
export const GlobeIcon = icon("globe");
export const GlobeSimpleIcon = icon("globe-simple");
export const HardDriveIcon = icon("hard-drive");
export const HardDrivesIcon = icon("hard-drives");
export const HouseIcon = icon("house");
export const InfoIcon = icon("info");
export const KeyIcon = icon("key");
export const LinkIcon = icon("link");
export const LockSimpleIcon = icon("lock-simple");
export const MagnifyingGlassIcon = icon("magnifying-glass");
export const MinusIcon = icon("minus");
export const PlusIcon = icon("plus");
export const PowerIcon = icon("power");
export const ShieldCheckIcon = icon("shield-check");
export const TerminalIcon = icon("terminal");
export const XIcon = icon("x");
