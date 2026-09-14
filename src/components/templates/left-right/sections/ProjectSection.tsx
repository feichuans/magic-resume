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
                              ATS parsers (Beisen / Feishu / Moka) split entries on
                              "entity + date" lines. Keep name+date on line 1, role on
                              line 2, and the URL labelled on line 3 — never insert a
                              bare URL between two project titles.
                            */}
                            <motion.div className="flex items-baseline justify-between gap-2">
                                <h3 className="font-bold min-w-0" style={{ fontSize: `${globalSettings?.subheaderSize || 16}px` }}>
                                    {project.name}
                                </h3>
                                <div className="text-subtitleFont shrink-0" style={{ fontSize: `${globalSettings?.subheaderSize || 16}px` }}>
                                    {formatDateString(project.date, locale)}
                                </div>
                            </motion.div>
                            {project.role && (
                                <motion.div layout="position" className="text-subtitleFont" style={{ fontSize: `${globalSettings?.subheaderSize || 16}px` }}>
                                    {project.role}
                                </motion.div>
                            )}
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
