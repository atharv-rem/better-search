import {
  AppWindow,
  Disc,
  File,
  FileAudio,
  FileC,
  FileCode,
  FileCpp,
  FileCSharp,
  FileCss,
  FileCsv,
  FileDoc,
  FileHtml,
  FileImage,
  FileJpg,
  FileJs,
  FileJsx,
  FileMd,
  FilePdf,
  FilePng,
  FilePpt,
  FilePy,
  FileRs,
  FileSql,
  FileSvg,
  FileText,
  FileTs,
  FileTsx,
  FileTxt,
  FileVideo,
  FileXls,
  FileZip,
  Folder,
  Link,
  Terminal,
  type Icon,
} from "@phosphor-icons/react";
import type { SearchResult } from "@/lib/backend";
import { extensionOf, groupOf, type FileGroup } from "@/lib/file-groups";

export interface FileIconSpec {
  Icon: Icon;
  color: string;
}

const FOLDER: FileIconSpec = { Icon: Folder, color: "#F5B73D" };
const GENERIC: FileIconSpec = { Icon: File, color: "#8B92A0" };

// Used when an extension has no icon of its own.
const GROUP_ICON: Record<FileGroup, FileIconSpec> = {
  folders: FOLDER,
  documents: { Icon: FileText, color: "#2B7CD3" },
  images: { Icon: FileImage, color: "#3DD6C0" },
  videos: { Icon: FileVideo, color: "#FF5C8A" },
  audio: { Icon: FileAudio, color: "#1ED760" },
  code: { Icon: FileCode, color: "#A78BFA" },
  archives: { Icon: FileZip, color: "#F5B73D" },
  apps: { Icon: AppWindow, color: "#4C9BF0" },
  other: GENERIC,
};

const DOC = { Icon: FileDoc, color: "#2B7CD3" };
const SHEET = { Icon: FileXls, color: "#21A366" };
const SLIDES = { Icon: FilePpt, color: "#E8672C" };
const JPG = { Icon: FileJpg, color: "#F2994A" };
const ARCHIVE = { Icon: FileZip, color: "#F5B73D" };
const EXE = { Icon: AppWindow, color: "#4C9BF0" };
const C_LANG = { Icon: FileC, color: "#5C8DDC" };
const CPP = { Icon: FileCpp, color: "#659AD2" };
const JS = { Icon: FileJs, color: "#F7DF1E" };
const TS = { Icon: FileTs, color: "#3178C6" };
const REACT = { Icon: FileJsx, color: "#61DAFB" };
const TXT = { Icon: FileTxt, color: "#A1A7B3" };

const BY_EXTENSION: Record<string, FileIconSpec> = {
  pdf: { Icon: FilePdf, color: "#E5484D" },
  doc: DOC,
  docx: DOC,
  odt: DOC,
  rtf: DOC,
  txt: TXT,
  md: { Icon: FileMd, color: "#9CA3AF" },
  xls: SHEET,
  xlsx: SHEET,
  csv: { Icon: FileCsv, color: "#21A366" },
  ppt: SLIDES,
  pptx: SLIDES,

  png: { Icon: FilePng, color: "#3DD6C0" },
  jpg: JPG,
  jpeg: JPG,
  svg: { Icon: FileSvg, color: "#FFB13B" },

  js: JS,
  jsx: REACT,
  ts: TS,
  tsx: { Icon: FileTsx, color: "#61DAFB" },
  py: { Icon: FilePy, color: "#4B8BBE" },
  rs: { Icon: FileRs, color: "#F74C00" },
  c: C_LANG,
  h: C_LANG,
  cpp: CPP,
  hpp: CPP,
  cs: { Icon: FileCSharp, color: "#9B4F96" },
  html: { Icon: FileHtml, color: "#E34F26" },
  css: { Icon: FileCss, color: "#1572B6" },
  sql: { Icon: FileSql, color: "#E38C00" },
  sh: { Icon: Terminal, color: "#4EAA25" },
  ps1: { Icon: Terminal, color: "#5391FE" },
  bat: { Icon: Terminal, color: "#C1F12E" },

  zip: ARCHIVE,
  rar: ARCHIVE,
  "7z": ARCHIVE,
  iso: { Icon: Disc, color: "#A78BFA" },

  exe: EXE,
  msi: EXE,
  appx: EXE,
  lnk: { Icon: Link, color: "#94A3B8" },
};

export function iconOf(result: SearchResult): FileIconSpec {
  if (result.type === "directory") return FOLDER;
  return BY_EXTENSION[extensionOf(result.name)] ?? GROUP_ICON[groupOf(result)];
}
