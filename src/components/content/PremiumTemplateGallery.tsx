import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CheckCircle2, Sparkles, Wand2, ImageIcon } from "lucide-react";

export interface GalleryTemplate {
  id: string;
  name: string;
  label: string;
  description: string;
  category: "service" | "retail" | "offer" | "corporate" | "local";
  previewImageUrl: string;
  autoSelected?: boolean;
  supportedBusinessTypes: string[];
  supportedCampaignIntents: string[];
}

interface PremiumTemplateGalleryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: GalleryTemplate[];
  selectedId: string;
  onSelect: (id: string) => void;
  internalCost: number;
  externalCost: number;
  aiCost: number;
  externalReady: boolean;
  aiReady: boolean;
  onGenerateInternal: () => void;
  onGenerateExternal?: () => void;
  onGenerateAi?: () => void;
  isGenerating: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  service: "Service Business",
  retail: "Retail / Product",
  offer: "Offer / Discount",
  corporate: "Corporate Professional",
  local: "Local Store",
};

const CATEGORY_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All styles" },
  { value: "service", label: "Service" },
  { value: "retail", label: "Retail" },
  { value: "offer", label: "Offer" },
  { value: "corporate", label: "Corporate" },
  { value: "local", label: "Local" },
];

export function PremiumTemplateGallery({
  open,
  onOpenChange,
  templates,
  selectedId,
  onSelect,
  internalCost,
  externalCost,
  aiCost,
  externalReady,
  aiReady,
  onGenerateInternal,
  onGenerateExternal,
  onGenerateAi,
  isGenerating,
}: PremiumTemplateGalleryProps) {
  const [filter, setFilter] = useState("all");

  const filteredTemplates = useMemo(() => {
    if (filter === "all") return templates;
    return templates.filter((t) => t.category === filter);
  }, [templates, filter]);

  const selectedTemplate = templates.find((t) => t.id === selectedId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Sparkles className="w-5 h-5 text-[#00D4FF]" />
            Premium Template Gallery
          </DialogTitle>
          <DialogDescription>
            Choose a premium leaflet style. Auto-select picks the best layout from your business profile.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2 mt-2">
          {CATEGORY_FILTERS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              onClick={() => setFilter(chip.value)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                filter === chip.value
                  ? "bg-slate-900 text-white"
                  : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-2">
          {filteredTemplates.map((template) => {
            const isSelected = template.id === selectedId;
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => onSelect(template.id)}
                className={`relative text-left rounded-xl border-2 overflow-hidden transition-all hover:shadow-md ${
                  isSelected
                    ? "border-[#00D4FF] ring-1 ring-[#00D4FF] bg-[#00D4FF]/5"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                {template.autoSelected && (
                  <div className="absolute top-2 right-2 z-10">
                    <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px]">
                      <Wand2 className="w-3 h-3 mr-1" />
                      Auto
                    </Badge>
                  </div>
                )}
                <div className="aspect-[4/3] bg-slate-50 flex items-center justify-center overflow-hidden">
                  {template.previewImageUrl ? (
                    <img
                      src={template.previewImageUrl}
                      alt={template.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <ImageIcon className="w-10 h-10 text-slate-300" />
                  )}
                </div>
                <div className="p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-slate-900 text-sm">{template.name}</p>
                    {isSelected && <CheckCircle2 className="w-4 h-4 text-[#00D4FF] shrink-0" />}
                  </div>
                  <p className="text-xs text-slate-500 mt-1">{template.description}</p>
                  <Badge variant="outline" className="mt-2 text-[10px] capitalize">
                    {CATEGORY_LABELS[template.category] || template.category}
                  </Badge>
                </div>
              </button>
            );
          })}
        </div>

        {selectedTemplate && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 mt-2">
            <p className="text-sm font-medium text-slate-900">
              Selected: {selectedTemplate.name}
              {selectedTemplate.autoSelected && (
                <span className="text-xs text-slate-500 ml-2">(auto-selected)</span>
              )}
            </p>
            <p className="text-xs text-slate-500 mt-0.5">{selectedTemplate.description}</p>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3 justify-end mt-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isGenerating}
          >
            Cancel
          </Button>
          {aiReady && onGenerateAi && (
            <Button
              onClick={onGenerateAi}
              disabled={isGenerating}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {isGenerating ? "Generating…" : `Generate Premium AI — ${aiCost} credits`}
            </Button>
          )}
          <Button
            onClick={onGenerateInternal}
            disabled={isGenerating}
            variant="secondary"
          >
            {isGenerating ? "Generating…" : `Internal Premium (fallback) — ${internalCost} credits`}
          </Button>
          {externalReady && onGenerateExternal && (
            <Button
              variant="outline"
              onClick={onGenerateExternal}
              disabled={isGenerating}
            >
              {isGenerating ? "Generating…" : `External Provider — ${externalCost} credits`}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
