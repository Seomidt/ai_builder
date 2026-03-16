// TimeRangeFilter — selects windowHours for analytics queries
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const TIME_RANGE_OPTIONS = [
  { label: "Last 1h",   value: "1"   },
  { label: "Last 6h",   value: "6"   },
  { label: "Last 24h",  value: "24"  },
  { label: "Last 48h",  value: "48"  },
  { label: "Last 7d",   value: "168" },
] as const;

export const BILLING_TIME_RANGE_OPTIONS = [
  { label: "Last 7d",   value: "168"  },
  { label: "Last 30d",  value: "720"  },
  { label: "Last 90d",  value: "2160" },
  { label: "Last 365d", value: "8760" },
] as const;

interface TimeRangeFilterProps {
  value: string;
  onChange: (v: string) => void;
  options?: { label: string; value: string }[];
  testId?: string;
}

export function TimeRangeFilter({
  value, onChange, options = TIME_RANGE_OPTIONS as unknown as { label: string; value: string }[], testId,
}: TimeRangeFilterProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-36" data-testid={testId ?? "time-range-filter"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(o => (
          <SelectItem key={o.value} value={o.value} data-testid={`time-range-option-${o.value}`}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
