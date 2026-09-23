import { Image, UploadSimple } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { uploadAsset } from "../api.js";

interface AssetPickerProps {
  value: string | null | undefined;
  /** When false the value cannot be cleared (e.g. emoji image is required). */
  allowClear?: boolean;
  onChange: (next: string | null) => void;
}

/**
 * Image asset editor: shows the current config reference (relative path or
 * URL) with a file picker that uploads into `<config dir>/assets/` and a
 * clear button for nullable fields.
 */
export function AssetPicker({ value, allowClear = true, onChange }: AssetPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setUploading(true);
    setError(null);
    const result = await uploadAsset(file);
    setUploading(false);
    if (result.ok) {
      onChange(result.path);
    } else {
      setError(result.error);
    }
  }

  const isUrl = typeof value === "string" && /^https?:\/\//i.test(value);

  return (
    <div className="asset-picker" data-testid="asset-picker">
      <div className="asset-picker-current">
        {value ? <Image size={14} aria-hidden /> : null}
        <span className="asset-picker-value" data-testid="asset-picker-value">
          {value ? (
            isUrl ? (
              <span className="asset-picker-url" title={value}>
                URL: {value.length > 48 ? `…${value.slice(-45)}` : value}
              </span>
            ) : (
              value
            )
          ) : (
            <span className="asset-picker-empty">(not set)</span>
          )}
        </span>
      </div>
      <div className="asset-picker-actions">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(e) => void handleFile(e)}
        />
        <button
          type="button"
          className="btn btn-sm btn-outline"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          data-testid="asset-picker-choose"
        >
          <UploadSimple size={13} weight="bold" />
          {uploading ? "Uploading…" : "Choose file…"}
        </button>
        {allowClear && value ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => onChange(null)}
            data-testid="asset-picker-clear"
          >
            Clear
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="asset-picker-error" data-testid="asset-picker-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}
