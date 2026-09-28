"use client";

import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Saves a CSV that was built on the server from the table's own rows (`toCsv`), so the file
 * always matches the numbers shown. The download happens in the browser (a Blob), with no second
 * request, so it works on a phone too.
 */
export function CsvDownloadButton({ csv, fileName, label = "Export CSV" }: { csv: string; fileName: string; label?: string }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  return (
    <Button type="button" variant="outline" size="sm" onClick={download} title={`Download ${fileName}`}>
      <Download aria-hidden />
      {label}
    </Button>
  );
}
