// GraphRenderer.ts
import * as d3 from "d3";

export interface GraphNode extends d3.SimulationNodeDatum {
    id: string;
    name: string;
    path: string;
    radius: number;
    isSelected?: boolean;
    color?: string;
}

export interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
    source: GraphNode;
    target: GraphNode;
    type?: string;
    tag?: string;
}

export interface GraphTag {
    name: string;
    color: string;
    files: Set<string>;
}

export interface GraphSettings {
    gravity: number;
    repelling: number;
    linkDistance: number;
    charge: number;
    centerStrength: number;
    showTagConnections: boolean;
}

export interface FileSummary {
    file: string;
    content: string;
    links: string[];
}

export class GraphRenderer {
    private graphSvg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
    private graphG: d3.Selection<SVGGElement, unknown, null, undefined>;
    private simulation: d3.Simulation<GraphNode, undefined>;
    private nodes: GraphNode[] = [];
    private links: GraphLink[] = [];
    private nodeElements: d3.Selection<SVGCircleElement, GraphNode, SVGGElement, unknown>;
    private linkElements: d3.Selection<SVGLineElement, GraphLink, SVGGElement, unknown>;
    private labelElements: d3.Selection<SVGTextElement, GraphNode, SVGGElement, unknown>;
    private tooltip: HTMLElement;

    // Remove the duplicate settings declaration and keep only this one:
    public settings: GraphSettings = {
        gravity: 0.1,
        repelling: 100,
        linkDistance: 100,
        charge: -30,
        centerStrength: 0.1,
        showTagConnections: false
    };

    private selectedNodes: Set<string> = new Set();
    private allData: Record<string, FileSummary> = {};
    private onNodeClick?: (node: GraphNode) => void;

    // Add these new properties
    private tags: Map<string, GraphTag> = new Map();
    private showSettings = true;
    private tagColorIndex = 1;
    private randomColorIndex = 1;

    constructor(
        private container: HTMLElement,
        data: Record<string, FileSummary>,
        selectedFiles: Set<string>,
        onNodeClick?: (node: GraphNode) => void
    ) {
        this.allData = data;
        this.selectedNodes = selectedFiles;
        this.onNodeClick = onNodeClick;
        this.initializeGraph();
    }

    public updateSelection(selectedFiles: Set<string>) {
        this.selectedNodes = selectedFiles;
        this.generateGraphData(); // This will use the latest tags
        this.updateGraphElements();
        this.restartSimulation();
    }

    public updateData(data: Record<string, FileSummary>) {
        this.allData = data;
        this.extractTags(); // Re-extract tags when data updates
        this.generateGraphData();
        this.updateGraphElements();
        this.restartSimulation();
    }

    private initializeGraph() {
        // Create tooltip
        this.tooltip = this.container.createDiv({ cls: 'graph-tooltip' });

        // Create settings toggle button
        const toggleBtn = this.container.createDiv({ cls: 'graph-settings-toggle' });
        toggleBtn.setText('⚙️');
        toggleBtn.onclick = () => this.toggleSettings();

        // Get container dimensions
        const containerRect = this.container.getBoundingClientRect();

        // Create SVG with zoom behavior
        this.graphSvg = d3.select(this.container)
            .append('svg')
            .attr('class', 'graph-svg')
            .attr('width', containerRect.width)
            .attr('height', containerRect.height)
            .call(d3.zoom<SVGSVGElement, unknown>()
                .scaleExtent([0.1, 4])
                .on('zoom', (event) => {
                    this.graphG.attr('transform', event.transform);
                })
            );

        this.graphG = this.graphSvg.append('g');

        // Extract tags from data
        this.extractTags();

        // Generate initial graph data
        this.generateGraphData();

        // Create graph elements first
        this.createGraphElements();

        // Then initialize simulation with the elements
        this.initializeSimulation();

        // Update graph on resize
        this.setupResizeObserver();
    }
    
    private extractTags() {
        this.tags.clear();
        this.tagColorIndex = 1;
    
        Object.entries(this.allData).forEach(([path, fileSummary]) => {
            // More inclusive regex that captures most characters used in tags
            // This matches # followed by any non-whitespace characters (except # and [])
            const tagMatches = fileSummary.content.matchAll(/#([^\s#\[\]]+)/g);
            
            for (const match of tagMatches) {
                let tagName = match[1].trim();
                
                // Remove common punctuation that might be at the end of tags
                tagName = tagName.replace(/[.,;!?]*$/, '');
                
                if (tagName && tagName.length > 0) {
                    // Skip if it's obviously not a tag (like numbers only)
                    if (/^\d+$/.test(tagName)) continue;
                    
                    if (!this.tags.has(tagName)) {
                        const tag: GraphTag = {
                            name: tagName,
                            color: `tag-color-${this.tagColorIndex}`,
                            files: new Set()
                        };
                        this.tags.set(tagName, tag);
                        this.tagColorIndex = (this.tagColorIndex % 10) + 1;
                    }
                    this.tags.get(tagName)!.files.add(path);
                }
            }
        });
    
        console.log(`Extracted ${this.tags.size} tags:`, Array.from(this.tags.keys()));
    }
    public getTagsForSelectedNodes(): Map<string, GraphTag> {
        const relevantTags = new Map<string, GraphTag>();
        
        this.tags.forEach((tag, tagName) => {
            // Check if any file with this tag is selected
            const hasSelectedFile = Array.from(tag.files).some(filePath => 
                this.selectedNodes.has(filePath)
            );
            
            if (hasSelectedFile) {
                relevantTags.set(tagName, tag);
            }
        });
        
        return relevantTags;
    }

    public getTags(): Map<string, GraphTag> {
        return this.tags;
    }
    // Add method to update tag colors
    public updateTagColor(tagName: string, colorClass: string) {
        const tag = this.tags.get(tagName);
        if (tag) {
            tag.color = colorClass;
            this.generateGraphData(); // Regenerate with new colors
            this.updateGraphElements();
            this.restartSimulation();
        }
    }

    private generateGraphData() {
        // Clear existing data
        this.nodes = [];
        this.links = [];
        this.randomColorIndex = 1;

        // If no files are selected, show nothing
        if (this.selectedNodes.size === 0) {
            console.log('No files selected for graph');
            return;
        }

        const nodeMap = new Map<string, GraphNode>();
        const fileTags = new Map<string, string[]>(); // file path -> array of tags

        // Create nodes only for selected files and extract their tags
        Object.entries(this.allData).forEach(([path, fileSummary]) => {
            const isSelected = this.selectedNodes.has(path) ||
                this.selectedNodes.has(fileSummary.file) ||
                this.selectedNodes.has(path.replace(/\.md$/, ''));

            if (isSelected) {
                // Extract tags for this file
                const fileTagMatches = fileSummary.content.matchAll(/#(\w+)/g);
                const tags: string[] = [];
                for (const match of fileTagMatches) {
                    tags.push(match[1]);
                }
                fileTags.set(path, tags);

                // Determine node color based on tags
                let nodeColor = '';
                if (tags.length > 0 && this.settings.showTagConnections) {
                    // Use the color of the first tag
                    const firstTag = this.tags.get(tags[0]);
                    nodeColor = firstTag ? firstTag.color : `random-color-${this.randomColorIndex}`;
                } else {
                    nodeColor = `random-color-${this.randomColorIndex}`;
                    this.randomColorIndex = (this.randomColorIndex % 5) + 1;
                }

                const node: GraphNode = {
                    id: fileSummary.file,
                    name: fileSummary.file,
                    path: path,
                    radius: 8,
                    isSelected: true,
                    color: nodeColor
                };
                this.nodes.push(node);
                nodeMap.set(fileSummary.file, node);
                nodeMap.set(path, node);
            }
        });

        console.log(`Created ${this.nodes.length} nodes for selected files`);

        // Create links between selected files (existing wiki links)
        Object.entries(this.allData).forEach(([path, fileSummary]) => {
            const isSourceSelected = this.selectedNodes.has(path) ||
                this.selectedNodes.has(fileSummary.file) ||
                this.selectedNodes.has(path.replace(/\.md$/, ''));

            if (isSourceSelected) {
                const sourceNode = nodeMap.get(fileSummary.file) || nodeMap.get(path);
                if (!sourceNode) return;

                // Regular wiki links
                fileSummary.links.forEach(link => {
                    const normalizedLink = link.replace(/\.md$/, '');
                    const targetEntry = Object.entries(this.allData).find(([targetPath, targetFile]) => {
                        return targetFile.file === normalizedLink ||
                            targetPath === normalizedLink ||
                            targetPath.replace(/\.md$/, '') === normalizedLink;
                    });

                    if (targetEntry) {
                        const [targetPath, targetFile] = targetEntry;
                        const isTargetSelected = this.selectedNodes.has(targetPath) ||
                            this.selectedNodes.has(targetFile.file) ||
                            this.selectedNodes.has(targetPath.replace(/\.md$/, ''));

                        if (isTargetSelected) {
                            const targetNode = nodeMap.get(targetFile.file) || nodeMap.get(targetPath);
                            if (targetNode && sourceNode.id !== targetNode.id) {
                                const linkExists = this.links.some(l =>
                                    (l.source.id === sourceNode.id && l.target.id === targetNode.id) ||
                                    (l.source.id === targetNode.id && l.target.id === sourceNode.id)
                                );

                                if (!linkExists) {
                                    this.links.push({
                                        source: sourceNode,
                                        target: targetNode,
                                        type: 'wiki-link'
                                    });
                                }
                            }
                        }
                    }
                });

                // Tag-based connections (if enabled)
                if (this.settings.showTagConnections) {
                    const sourceTags = fileTags.get(path) || [];
                    sourceTags.forEach(tag => {
                        const tagData = this.tags.get(tag);
                        if (tagData) {
                            tagData.files.forEach(targetPath => {
                                if (targetPath !== path && this.selectedNodes.has(targetPath)) {
                                    const targetNode = nodeMap.get(targetPath);
                                    if (targetNode && sourceNode.id !== targetNode.id) {
                                        const linkExists = this.links.some(l =>
                                            (l.source.id === sourceNode.id && l.target.id === targetNode.id) ||
                                            (l.source.id === targetNode.id && l.target.id === sourceNode.id)
                                        );

                                        if (!linkExists) {
                                            this.links.push({
                                                source: sourceNode,
                                                target: targetNode,
                                                type: 'tag-link',
                                                tag: tag
                                            });
                                        }
                                    }
                                }
                            });
                        }
                    });
                }
            }
        });

        console.log(`Generated graph with ${this.nodes.length} nodes and ${this.links.length} links`);
    }

    private initializeSimulation() {
        // Stop existing simulation if it exists
        if (this.simulation) {
            this.simulation.stop();
        }

        const containerRect = this.container.getBoundingClientRect();

        console.log('Initializing simulation with:', {
            nodes: this.nodes.length,
            links: this.links.length,
            container: { width: containerRect.width, height: containerRect.height },
            settings: this.settings
        });

        // Create the simulation with proper configuration
        this.simulation = d3.forceSimulation<GraphNode>(this.nodes)
            .force("link", d3.forceLink<GraphNode, GraphLink>(this.links)
                .id(d => d.id)
                .distance(this.settings.linkDistance)
            )
            .force("charge", d3.forceManyBody<GraphNode>()
                .strength(d => this.settings.charge * (this.settings.repelling / 100))
                .distanceMin(10)
                .distanceMax(200)
            )
            .force("center", d3.forceCenter(containerRect.width / 2, containerRect.height / 2))
            .force("x", d3.forceX(containerRect.width / 2).strength(this.settings.centerStrength))
            .force("y", d3.forceY(containerRect.height / 2).strength(this.settings.gravity))
            .force("collision", d3.forceCollide<GraphNode>()
                .radius(d => d.radius + 5)
                .strength(0.5)
            )
            .alphaDecay(0.1)
            .velocityDecay(0.6)
            .alphaMin(0.001)
            .alpha(0.5)
            .on("tick", () => {
                this.ticked();
            });

        console.log('Simulation created:', this.simulation);

        // Force the simulation to run for a bit
        this.simulation.restart();
    }



    private createGraphElements() {
        // Remove existing elements
        this.graphG.selectAll('*').remove();

        // Create links with different styles based on type
        this.linkElements = this.graphG.append('g')
            .selectAll('line')
            .data(this.links)
            .enter()
            .append('line')
            .attr('class', (d: GraphLink) => `graph-link ${d.type}`)
            .style('stroke', (d: GraphLink) => {
                if (d.type === 'tag-link' && d.tag) {
                    const tag = this.tags.get(d.tag);
                    return tag ? this.getTagColor(tag.color) : '#999';
                }
                return '#999'; // Default color for wiki links
            })
            .style('stroke-width', (d: GraphLink) => d.type === 'tag-link' ? 1.5 : 2)
            .style('stroke-dasharray', (d: GraphLink) => d.type === 'tag-link' ? '5,5' : 'none')
            .style('stroke-opacity', 0.6);

        // Create nodes with colors
        this.nodeElements = this.graphG.append('g')
            .selectAll('circle')
            .data(this.nodes)
            .enter()
            .append('circle')
            .attr('class', (d: GraphNode) => `graph-node ${d.color}`)
            .attr('r', (d: GraphNode) => d.radius)
            .style('fill', (d: GraphNode) => this.getNodeColor(d.color || ''))
            .style('cursor', 'pointer')
            .style('stroke', '#333')
            .style('stroke-width', 2)
            .call(this.createDragBehavior())
            .on('mouseover', (event, d) => this.showTooltip(event, d))
            .on('mouseout', () => this.hideTooltip());

        // Create labels
        this.labelElements = this.graphG.append('g')
            .selectAll('text')
            .data(this.nodes)
            .enter()
            .append('text')
            .attr('class', 'graph-label')
            .text((d: GraphNode) => d.name)
            .attr('text-anchor', 'middle')
            .attr('dy', -10)
            .style('font-size', '12px')
            .style('pointer-events', 'none')
            .style('fill', '#333')
            .style('font-weight', 'bold');

        console.log('Graph elements created');
    }

    private getTagColor(colorClass: string): string {
        // Map color classes to actual colors
        const colorMap: { [key: string]: string } = {
            'tag-color-1': '#ff6b6b',
            'tag-color-2': '#4ecdc4',
            'tag-color-3': '#45b7d1',
            'tag-color-4': '#96ceb4',
            'tag-color-5': '#feca57',
            'tag-color-6': '#ff9ff3',
            'tag-color-7': '#54a0ff',
            'tag-color-8': '#5f27cd',
            'tag-color-9': '#00d2d3',
            'tag-color-10': '#ff9f43'
        };
        return colorMap[colorClass] || '#999';
    }

    private getNodeColor(colorClass: string): string {
        const colorMap: { [key: string]: string } = {
            'random-color-1': '#a29bfe',
            'random-color-2': '#fd79a8',
            'random-color-3': '#fdcb6e',
            'random-color-4': '#e17055',
            'random-color-5': '#00b894',
            ...this.getTagColorMap() // Include tag colors
        };
        return colorMap[colorClass] || '#69b3a2';
    }

    private getTagColorMap(): { [key: string]: string } {
        return {
            'tag-color-1': '#ff6b6b',
            'tag-color-2': '#4ecdc4',
            'tag-color-3': '#45b7d1',
            'tag-color-4': '#96ceb4',
            'tag-color-5': '#feca57',
            'tag-color-6': '#ff9ff3',
            'tag-color-7': '#54a0ff',
            'tag-color-8': '#5f27cd',
            'tag-color-9': '#00d2d3',
            'tag-color-10': '#ff9f43'
        };
    }

    private toggleSettings() {
        this.showSettings = !this.showSettings;
        const settingsPanel = this.container.querySelector('.graph-settings');
        if (settingsPanel) {
            if (this.showSettings) {
                settingsPanel.classList.remove('hidden');
            } else {
                settingsPanel.classList.add('hidden');
            }
        }
    }

    private createDragBehavior() {
        const drag = d3.drag<SVGCircleElement, GraphNode, GraphNode>()
            .on('start', (event, d) => {
                console.log('Drag started on node:', d.id);

                // Don't stop the simulation completely, just reduce its influence
                this.simulation.alphaTarget(0.1).restart(); // Keep some simulation running

                d.fx = d.x;
                d.fy = d.y;
            })
            .on('drag', (event, d) => {
                // Update the fixed position to follow mouse exactly
                d.fx = event.x;
                d.fy = event.y;

                // Force immediate visual update without restarting simulation
                this.updatePositions();
            })
            .on('end', (event, d) => {
                console.log('Drag ended');

                // Release the fixed position
                d.fx = null;
                d.fy = null;

                // Give the simulation a boost to settle the graph
                this.simulation.alphaTarget(0);
                this.simulation.alpha(0.3).restart();
            });

        return drag;
    }

    private ticked() {
        this.updatePositions();
    }

    private updateGraphElements() {
        console.log('Updating graph elements');

        // Update nodes
        this.nodeElements = this.graphG.selectAll<SVGCircleElement, GraphNode>('circle')
            .data(this.nodes, (d: GraphNode) => d.id)
            .join(
                enter => enter.append('circle')
                    .attr('class', 'graph-node')
                    .attr('r', (d: GraphNode) => d.radius)
                    .style('fill', '#69b3a2')
                    .style('cursor', 'pointer')
                    .style('stroke', '#333')
                    .style('stroke-width', 2)
                    .call(this.createDragBehavior())
                    .on('mouseover', (event, d) => this.showTooltip(event, d))
                    .on('mouseout', () => this.hideTooltip()),
                update => update,
                exit => exit.remove()
            );

        // Update links
        this.linkElements = this.graphG.selectAll<SVGLineElement, GraphLink>('line')
            .data(this.links, (d: GraphLink) => `${d.source.id}-${d.target.id}`)
            .join(
                enter => enter.append('line')
                    .attr('class', 'graph-link')
                    .style('stroke', '#999')
                    .style('stroke-width', 2)
                    .style('stroke-opacity', 0.6),
                update => update,
                exit => exit.remove()
            );

        // Update labels
        this.labelElements = this.graphG.selectAll<SVGTextElement, GraphNode>('text')
            .data(this.nodes, (d: GraphNode) => d.id)
            .join(
                enter => enter.append('text')
                    .attr('class', 'graph-label')
                    .text((d: GraphNode) => d.name)
                    .attr('text-anchor', 'middle')
                    .attr('dy', -10)
                    .style('font-size', '12px')
                    .style('pointer-events', 'none')
                    .style('fill', '#333')
                    .style('font-weight', 'bold'),
                update => update,
                exit => exit.remove()
            );

        // Re-initialize simulation with new data
        this.initializeSimulation();
    }

    private updatePositions() {
        if (!this.linkElements || !this.nodeElements || !this.labelElements) {
            return;
        }

        // Update link positions
        this.linkElements
            .attr('x1', (d: GraphLink) => d.source.x ?? 0)
            .attr('y1', (d: GraphLink) => d.source.y ?? 0)
            .attr('x2', (d: GraphLink) => d.target.x ?? 0)
            .attr('y2', (d: GraphLink) => d.target.y ?? 0);

        // Update node positions
        this.nodeElements
            .attr('cx', (d: GraphNode) => d.x ?? 0)
            .attr('cy', (d: GraphNode) => d.y ?? 0);

        // Update label positions
        this.labelElements
            .attr('x', (d: GraphNode) => d.x ?? 0)
            .attr('y', (d: GraphNode) => d.y ?? 0);
    }

    private showTooltip(event: MouseEvent, d: GraphNode) {
        this.tooltip.textContent = d.name;
        this.tooltip.style.opacity = '1';
        this.tooltip.style.left = (event.pageX + 10) + 'px';
        this.tooltip.style.top = (event.pageY - 25) + 'px';

        // Highlight connected nodes
        this.highlightConnectedNodes(d);
    }

    private hideTooltip() {
        this.tooltip.style.opacity = '0';
        this.resetNodeStyles();
    }

    private highlightConnectedNodes(centerNode: GraphNode) {
        const connectedNodeIds = new Set<string>();
        connectedNodeIds.add(centerNode.id);

        this.links.forEach(link => {
            if (link.source.id === centerNode.id) connectedNodeIds.add(link.target.id);
            if (link.target.id === centerNode.id) connectedNodeIds.add(link.source.id);
        });

        this.nodeElements
            .style('opacity', (d: GraphNode) => connectedNodeIds.has(d.id) ? '1' : '0.3');

        this.linkElements
            .style('stroke-opacity', (d: GraphLink) =>
                connectedNodeIds.has(d.source.id) && connectedNodeIds.has(d.target.id) ? '0.8' : '0.2'
            );
    }

    private resetNodeStyles() {
        this.nodeElements.style('opacity', '1');
        this.linkElements.style('stroke-opacity', '0.6');
    }

    public updateSimulation() {
        if (!this.simulation) {
            console.log('No simulation to update');
            return;
        }

        console.log('Updating simulation with new settings:', this.settings);

        const containerRect = this.container.getBoundingClientRect();

        // Recreate all forces with new settings
        this.simulation
            .force("link", d3.forceLink<GraphNode, GraphLink>(this.links)
                .id(d => d.id)
                .distance(this.settings.linkDistance)
            )
            .force("charge", d3.forceManyBody<GraphNode>()
                .strength(d => this.settings.charge * (this.settings.repelling / 100))
                .distanceMin(10)
                .distanceMax(200)
            )
            .force("center", d3.forceCenter(containerRect.width / 2, containerRect.height / 2))
            .force("x", d3.forceX(containerRect.width / 2).strength(this.settings.centerStrength))
            .force("y", d3.forceY(containerRect.height / 2).strength(this.settings.gravity))
            .force("collision", d3.forceCollide<GraphNode>()
                .radius(d => d.radius + 5)
                .strength(0.5)
            )
            .alphaDecay(0.1)
            .velocityDecay(0.6)
            .alphaMin(0.001)
            .alpha(0.3)
            .restart();

        console.log('Simulation updated and restarted');
    }

    public centerGraph() {
        if (this.nodes.length === 0) return;

        try {
            const bounds = this.graphG.node()?.getBBox();
            if (!bounds || bounds.width === 0 || bounds.height === 0) return;

            const parent = this.graphSvg.node()?.getBoundingClientRect();
            if (!parent) return;

            const fullWidth = parent.width;
            const fullHeight = parent.height;
            const width = bounds.width;
            const height = bounds.height;

            const midX = bounds.x + width / 2;
            const midY = bounds.y + height / 2;

            const scale = 0.85 / Math.max(width / fullWidth, height / fullHeight);
            const translate = [
                fullWidth / 2 - scale * midX,
                fullHeight / 2 - scale * midY
            ];

            this.graphSvg.transition()
                .duration(750)
                .call(
                    d3.zoom<SVGSVGElement, unknown>().transform,
                    d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale)
                );
        } catch (error) {
            console.error('Error centering graph:', error);
        }
    }

    private setupResizeObserver() {
        const resizeObserver = new ResizeObserver(() => {
            const rect = this.container.getBoundingClientRect();
            this.graphSvg
                .attr('width', rect.width)
                .attr('height', rect.height);

            if (this.simulation) {
                this.simulation.force("center", d3.forceCenter(rect.width / 2, rect.height / 2));
                this.simulation.alpha(0.3).restart();
            }
        });

        resizeObserver.observe(this.container);
    }

    public restartSimulation() {
        if (this.simulation) {
            console.log('Restarting simulation');
            this.simulation.alpha(0.5).restart();
        }
    }

    public destroy() {
        if (this.simulation) {
            this.simulation.stop();
        }
        if (this.graphSvg) {
            this.graphSvg.remove();
        }
        if (this.tooltip) {
            this.tooltip.remove();
        }
    }
}