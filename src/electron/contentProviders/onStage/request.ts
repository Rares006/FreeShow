/**
 * WARNING: This file should ONLY be accessed through OnStageProvider.
 * Do not import or use functions from this file directly in other parts of the application.
 * Use ContentProviderRegistry or OnStageProvider instead.
 *
 * OnStage's presenter API returns services presentation-ready: sections arrive in arrangement
 * order with repeats resolved and lyrics already split into slides, so this file is a plain
 * transport + type mapping layer with no parsing.
 */

import { uid } from "uid"
import { ToMain } from "../../../types/IPC/ToMain"
import type { Show, Slide, SlideData } from "../../../types/Show"
import { sendToMain } from "../../IPC/main"
import { onStageApiRequest, onStageConnect } from "./connect"

type OnStageSlide = { lines: string[] }
type OnStageSection = {
    label: string
    number: number
    name: string
    repeats: number
    notes: string | null
    instrumental: boolean
    unscheduled: boolean
    slides: OnStageSlide[]
}
type OnStageSong = {
    id: string
    title: string
    artist: string | null
    key: string | null
    originalKey: string | null
    tempo: number | null
    meter: string | null
    ccli: string | null
    copyright: string | null
    sections: OnStageSection[]
}
type OnStageServiceItem = {
    type: "song" | "moment"
    name: string | null
    notes: string | null
    index: number | null
    durationMs: number
    song: OnStageSong | null
}
type OnStageServiceOverview = { id: string; name: string | null; dateTime: string; location: string | null; itemCount: number; updatedAt: string | null }
// The wire shape PROVIDER_PROJECTS expects — the frontend handler builds the real Project from it.
type ProviderProjectItem = { type: "show" | "section"; id: string; scheduleLength: number; name?: string; notes?: string }
type ProviderProject = { id: string; name: string; scheduledTo: number; created: number; folderId: string; folderName: string; items: ProviderProjectItem[] }
type OnStageServiceDetail = { id: string; name: string | null; dateTime: string; location: string | null; updatedAt: string | null; items: OnStageServiceItem[] }

const itemStyle = "left:50px;top:120px;width:1820px;height:840px;"
// Repeated sections are expressed as repeated layout references to one slide. Legacy imports have
// carried absurd counts (a real song arrived with reps 104), so occurrences are capped.
const MAX_REPEAT_OCCURRENCES = 16

async function onStageRequest<T>(endpoint: string): Promise<T | null> {
    const access = await onStageConnect("presenter")
    if (!access) {
        sendToMain(ToMain.ALERT, "Not authorized at OnStage (try to disconnect and connect again)")
        return null
    }

    return new Promise((resolve) => {
        onStageApiRequest(`/integrations/v1${endpoint}`, "GET", { Authorization: `Bearer ${access.access_token}` }, {}, (err, result) => {
            if (err) {
                console.error(`Could not get OnStage data at ${endpoint}:`, err.message)
                return resolve(null)
            }
            resolve(result as T)
        })
    })
}

export async function onStageLoadServices(): Promise<void> {
    const list = await onStageRequest<{ services: OnStageServiceOverview[]; hasMore: boolean }>("/services")
    if (!list?.services?.length) return

    sendToMain(ToMain.TOAST, "Getting schedules from OnStage")

    const projects: ProviderProject[] = []
    const shows: (Show & { id: string })[] = []
    // A song appearing in several services is one show — render it once per sync.
    const builtShowIds = new Set<string>()

    for (const overview of list.services) {
        const service = await onStageRequest<OnStageServiceDetail>(`/services/${overview.id}`)
        if (!service?.items?.length) continue

        const projectItems: ProviderProjectItem[] = []
        for (const item of service.items) {
            if (item.type === "song" && item.song) {
                const showId = `onstagesong_${item.song.id}`
                if (!builtShowIds.has(showId)) {
                    builtShowIds.add(showId)
                    shows.push({ id: showId, ...getShow(item.song) })
                }
                projectItems.push({ type: "show", id: showId, scheduleLength: Math.round(item.durationMs / 1000) })
            } else {
                projectItems.push({
                    type: "section",
                    id: uid(5),
                    name: item.name || "",
                    scheduleLength: Math.round(item.durationMs / 1000),
                    notes: item.notes || ""
                })
            }
        }
        if (!projectItems.length) continue

        projects.push({
            id: service.id,
            name: service.name || service.dateTime.slice(0, 10),
            scheduledTo: new Date(service.dateTime).getTime(),
            created: new Date(service.updatedAt || service.dateTime).getTime(),
            folderId: "",
            folderName: "",
            items: projectItems
        })
    }

    sendToMain(ToMain.PROVIDER_PROJECTS, { providerId: "onstage", categoryName: "OnStage", shows, projects })
}

function getShow(song: OnStageSong): Show {
    const slides: { [key: string]: Slide } = {}
    const layoutSlides: SlideData[] = []
    // One slide group per section TYPE: a section played again later in the arrangement is the
    // same group referenced again by the layout, never a duplicated slide.
    const parentBySection: { [key: string]: string } = {}

    song.sections.forEach((section) => {
        const sectionKey = `${section.label} ${section.number}`
        let parentId = parentBySection[sectionKey]

        if (!parentId) {
            const sectionSlides: OnStageSlide[] = section.slides.length ? section.slides : [{ lines: [] }]
            const children: string[] = []

            sectionSlides.forEach((sectionSlide, i) => {
                const slideId = uid()
                slides[slideId] = {
                    // Only the parent carries the group — a labeled child would count as its own group.
                    group: i === 0 ? section.name : null,
                    ...(i === 0 ? { globalGroup: section.label.toLowerCase() } : {}),
                    color: null,
                    settings: {},
                    notes: section.notes || "",
                    items: sectionSlide.lines.length
                        ? [
                              {
                                  style: itemStyle,
                                  lines: sectionSlide.lines.map((line) => ({ align: "", text: [{ style: "", value: line }] }))
                              }
                          ]
                        : []
                }

                if (i === 0) parentId = slideId
                else children.push(slideId)
            })

            if (children.length && parentId) slides[parentId].children = children
            parentBySection[sectionKey] = parentId!
        }

        // A muted (repeats 0) or unscheduled section stays part of the song but out of the
        // presented layout; an instrumental section is presented as a single empty slide; a
        // repeated section is referenced by the layout once per play-through.
        const occurrences = section.unscheduled ? 0 : Math.min(section.repeats, MAX_REPEAT_OCCURRENCES)
        if (section.repeats > MAX_REPEAT_OCCURRENCES) console.warn(`OnStage: capping section "${section.name}" of "${song.title}" from ${section.repeats} to ${MAX_REPEAT_OCCURRENCES} repeats`)
        for (let repeat = 0; repeat < occurrences; repeat++) layoutSlides.push({ id: parentId! })
    })

    const layoutId = uid()
    return {
        name: song.title || "",
        category: "onstage",
        timestamps: { created: Date.now(), modified: null, used: null },
        meta: {
            title: song.title || "",
            artist: song.artist || "",
            CCLI: song.ccli || "",
            copyright: song.copyright || "",
            key: song.key || ""
        },
        settings: { activeLayout: layoutId, template: null },
        layouts: {
            [layoutId]: { name: "Default", notes: "", slides: layoutSlides }
        },
        slides,
        media: {}
    }
}
