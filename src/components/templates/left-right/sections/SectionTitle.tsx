import { useMemo } from "react";
import { GlobalSettings } from "@/types/resume";
import { useTemplateContext } from "../../TemplateContext";

interface SectionTitleProps {
    globalSettings?: GlobalSettings;
    type: string;
    title?: string;
    showTitle?: boolean;
}

const SectionTitle = ({ type, title, globalSettings, showTitle = true }: SectionTitleProps) => {
    const templateContext = useTemplateContext();
    const menuSections = templateContext?.menuSections ?? [];

    const renderTitle = useMemo(() => {
        if (type === "custom") return title;
        return menuSections.find((s) => s.id === type)?.title;
    }, [menuSections, type, title]);

    const themeColor = globalSettings?.themeColor;
    if (!showTitle) return null;

    // Keep the coloured bar in the document flow. An absolutely-positioned overlay
    // used to paint the 10% fill, but ATS parsers then read the heading after the
    // section body (or at the bottom of the page).
    return (
        <h2
            className="pl-4 py-1 flex items-center font-bold"
            style={{
                fontSize: `${globalSettings?.headerSize || 18}px`,
                color: themeColor,
                borderLeft: `3px solid ${themeColor}`,
                backgroundColor: themeColor ? `${themeColor}1A` : undefined,
                marginBottom: `${globalSettings?.paragraphSpacing}px`,
            }}
        >
            {renderTitle}
        </h2>
    );
};

export default SectionTitle;
