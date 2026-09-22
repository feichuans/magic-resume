import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import SectionTitle from "./SectionTitle";
import SectionWrapper from "../../shared/SectionWrapper";
import { Project, GlobalSettings } from "@/types/resume";
import { normalizeRichTextContent } from "@/lib/richText";
import { formatDateString } from "@/lib/utils";
import { useLocale } from "@/i18n/compat/client";
import { getProjectLinkMeta } from "@/lib/projectLink";

interface ProjectSectionProps {
    projects: Project[];
    globalSettings?: GlobalSettings;
    showTitle?: boolean;
}

const ProjectSection: React.FC<ProjectSectionProps> = ({ projects, globalSettings, showTitle = true }) => {
    const locale = useLocale();
    const visibleProjects = projects?.filter((p) => p.visible);

    return (
        <SectionWrapper sectionId="projects" style={{ marginTop: `${globalSettings?.sectionSpacing || 24}px` }}>
            <SectionTitle type="projects" globalSettings={globalSettings} showTitle={showTitle} />
            <motion.div layout="position">
                <AnimatePresence mode="popLayout">
                    {visibleProjects.map((project) => {
                        const projectLink = getProjectLinkMeta(project, {
                            preferFullUrl: true,
                        });

                        return (
                        <motion.div
                            key={project.id}
                            className="resume-entry"
                            style={{ marginTop: `${globalSettings?.paragraphSpacing}px` }}
                        >
                            {/*
                              Mirror the experience header so parsers read the same
                              shape: entity | role | date on one line. A role on its
                              own line has no date anchor, so parsers drop it or
                              attach it to the neighbouring entry.
                            */}
                            <motion.div className="flex items-center gap-2">
                                <h3 className="font-bold flex-[1.5] min-w-0" style={{ fontSize: `${globalSettings?.subheaderSize || 16}px` }}>
                                    {project.name}
                                </h3>
                                {project.role && (
                                    <motion.div className="text-subtitleFont flex-1 min-w-0" style={{ fontSize: `${globalSettings?.subheaderSize || 16}px` }}>
                                        {project.role}
                                    </motion.div>
                                )}
                                <div className="text-subtitleFont shrink-0 flex-1 text-right" style={{ fontSize: `${globalSettings?.subheaderSize || 16}px` }}>
                                    {formatDateString(project.date, locale)}
                                </div>
                            </motion.div>
                            {projectLink && (
                                <div className="text-subtitleFont" style={{ fontSize: `${globalSettings?.baseFontSize || 14}px` }}>
                                    项目地址：
                                    <a href={projectLink.href} target="_blank" rel="noopener noreferrer" className="underline" title={projectLink.title}>
                                        {projectLink.href}
                                    </a>
                                </div>
                            )}
                            {project.description && (
                                <motion.div layout="position" className="mt-1 text-baseFont"
                                    style={{ fontSize: `${globalSettings?.baseFontSize || 14}px`, lineHeight: globalSettings?.lineHeight || 1.6 }}
                                    dangerouslySetInnerHTML={{ __html: normalizeRichTextContent(project.description) }}
                                />
                            )}
                        </motion.div>
                    )})}
                </AnimatePresence>
            </motion.div>
        </SectionWrapper>
    );
};

export default ProjectSection;
