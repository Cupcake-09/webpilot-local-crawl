import { useMemo, useState } from 'react'

const UNIT_COLORS = ['#34D399', '#22D3EE', '#A78BFA', '#FBBF24', '#FB7185']
const NODE_HEIGHT = 44

const fmtNumber = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return number.toLocaleString(undefined, { maximumFractionDigits: 2 })
}
const truncate = (value, limit = 24) => {
  const clean = String(value ?? '')
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean
}

function Empty({ text }) {
  return (
    <div className="rounded-xl border border-dashed border-[#2F2F2F] bg-[#171717] p-6 text-center text-[12px] leading-5 text-[#8A8A8A]">
      {text}
    </div>
  )
}

function Kpi({ label, value, hint, accent }) {
  return (
    <div className="min-w-0 rounded-2xl border border-[#2F2F2F] bg-[#1E1E1E] p-4">
      <p className="text-[10px] uppercase tracking-[0.09em] text-[#7A7A7A]">{label}</p>
      <p
        className={`mt-1.5 truncate text-[18px] font-medium ${accent ? 'text-[#34D399]' : 'text-[#ECECEC]'}`}
        title={String(value ?? '')}
      >
        {value || '—'}
      </p>
      <p className="mt-0.5 truncate text-[11px] text-[#8A8A8A]" title={hint}>
        {hint}
      </p>
    </div>
  )
}

function KpiStrip({ payload }) {
  const stats = payload?.stats ?? {}
  const numeric = payload?.numericSeries ?? []
  const highest = stats.highestSection
  const snr = stats.concepts ? `${stats.signalToNoise ?? 0}%` : '—'

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi
        label="Signal-to-Noise Ratio"
        value={snr}
        hint="share of foraged terms above salience 3.5"
        accent
      />
      <Kpi
        label="Top Harvested Entity"
        value={stats.topEntity}
        hint={stats.topEntity ? `peak salience ${fmtNumber(stats.topEntityScore)}` : 'no entity harvested yet'}
      />
      <Kpi
        label="Numeric Data Points"
        value={fmtNumber(numeric.length)}
        hint={numeric.length ? `paired across ${stats.sections ?? 0} sections` : 'no numbers paired with sections'}
      />
      <Kpi
        label="Highest-Salience Section"
        value={highest?.heading}
        hint={highest ? `avg ${fmtNumber(highest.avgScore)} · ${highest.gripCount} grips` : 'no section scores yet'}
      />
    </div>
  )
}

function Takeaways({ payload }) {
  const bullets = []
  const numeric = payload?.numericSeries ?? []
  if (numeric.length) {
    const top = numeric[0]
    bullets.push({
      label: 'Top quantitative finding',
      text: `${top.raw} is the largest foraged value, tied to “${top.entity}” in “${top.sectionHeading}”.`,
    })
  }
  const highest = payload?.stats?.highestSection
  if (highest) {
    bullets.push({
      label: 'Strongest evidence section',
      text: `“${highest.heading}” held the densest signal: avg salience ${fmtNumber(highest.avgScore)} across ${highest.gripCount} grips.`,
    })
  }
  const concepts = payload?.topConcepts ?? []
  if (concepts.length) {
    const cluster = concepts.slice(0, 4).map((item) => item.word)
    bullets.push({
      label: 'Primary entity cluster',
      text: `${cluster.join(' · ')}${concepts.length > 4 ? ` (+${concepts.length - 4} more)` : ''} form the dominant cluster.`,
    })
  }

  if (!bullets.length) return null

  return (
    <section className="rounded-2xl border border-[#2F2F2F] bg-[#1E1E1E] p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-medium text-[#ECECEC]">Auto-Synthesized Key Takeaways</h2>
        <span className="rounded-full border border-[#2F2F2F] bg-[#171717] px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-wide text-[#8A8A8A]">
          generated
        </span>
      </div>
      <ul className="mt-3 grid gap-2.5 md:grid-cols-3">
        {bullets.slice(0, 3).map((bullet) => (
          <li key={bullet.label} className="min-w-0 rounded-xl border border-[#2A2A2A] bg-[#171717] p-3">
            <p className="text-[9.5px] uppercase tracking-[0.08em] text-[#7A7A7A]">{bullet.label}</p>
            <p className="mt-1.5 text-[12px] leading-5 text-[#D4D4D4]">{bullet.text}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function MetricComparisonChart({ points }) {
  const [active, setActive] = useState(null)

  const groups = []
  const byEntity = new Map()
  for (const point of points) {
    const key = point.entity || point.sectionHeading || 'Unassigned'
    if (!byEntity.has(key)) {
      const group = { entity: key, points: [] }
      byEntity.set(key, group)
      groups.push(group)
    }
    byEntity.get(key).points.push(point)
  }
  const visibleGroups = groups.slice(0, 6).map((group) => ({ ...group, points: group.points.slice(0, 3) }))
  const unitIndex = [...new Set(visibleGroups.flatMap((group) => group.points.map((point) => point.unit || 'value')))]

  const width = 760
  const left = 176
  const right = 96
  const top = 20
  const rowHeight = 26
  const groupGap = 14
  const plotWidth = width - left - right

  let cursor = top
  const rows = []
  const groupLabels = []
  for (const group of visibleGroups) {
    const start = cursor
    for (const point of group.points) {
      rows.push({ ...point, group: group.entity, y: cursor + rowHeight / 2 })
      cursor += rowHeight
    }
    groupLabels.push({ entity: group.entity, y: (start + cursor - rowHeight / 2) / 2 })
    cursor += groupGap
  }
  const height = Math.max(230, cursor + 16)
  const unitMax = new Map()
  for (const row of rows) unitMax.set(row.unit || 'value', Math.max(unitMax.get(row.unit || 'value') ?? 0, row.value))
  const colorOf = (unit) => UNIT_COLORS[Math.max(0, unitIndex.indexOf(unit || 'value')) % UNIT_COLORS.length]
  const current = active != null ? rows[active] : null

  if (!points.length) {
    return <Empty text="No numeric metrics yet. Let Auto-Iterate walk a section that contains numbers to build this series." />
  }

  return (
    <div>
      <div className="mb-2 h-5 truncate text-[11.5px] text-[#8A8A8A]">
        {current ? (
          <span className="text-[#ECECEC]">
            {current.raw} <span className="text-[#8A8A8A]">· {current.group} · source: {current.sectionHeading}</span>
          </span>
        ) : (
          'Hover a bar to see its entity and source section'
        )}
      </div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full min-w-[620px]"
          role="img"
          aria-label="Extracted numeric metrics by entity"
        >
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
            <line
              key={fraction}
              x1={left + plotWidth * fraction}
              x2={left + plotWidth * fraction}
              y1={top - 4}
              y2={height - 10}
              stroke="#2F2F2F"
              strokeDasharray={fraction === 0 ? undefined : '2 4'}
              strokeWidth="1"
            />
          ))}
          {groupLabels.map((group) => (
            <text key={`group-${group.entity}`} x={8} y={group.y + 3.5} fontSize="10" fill="#BDBDBD">
              {truncate(group.entity, 13)}
            </text>
          ))}
          {rows.map((row, index) => {
            const unit = row.unit || 'value'
            const max = Math.max(1, unitMax.get(unit) ?? 1)
            const barWidth = Math.max(2, (row.value / max) * plotWidth)
            const isActive = active === index
            return (
              <g
                key={`${row.raw}-${row.sectionHeading}-${index}`}
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive(null)}
              >
                <rect x={left} y={row.y - rowHeight / 2} width={plotWidth} height={rowHeight} fill="transparent" />
                <rect
                  x={left}
                  y={row.y - 7}
                  width={barWidth}
                  height="14"
                  rx="4"
                  fill={colorOf(unit)}
                  opacity={isActive ? 1 : 0.82}
                  className="transition-opacity duration-150"
                />
                <text x={left + barWidth + 7} y={row.y + 3} fontSize="9.5" fill={isActive ? '#ECECEC' : '#8A8A8A'}>
                  {fmtNumber(row.value)}
                  {unit !== 'value' ? ` ${unit}` : ''}
                </text>
                <text x={left - 12} y={row.y + 3.5} textAnchor="end" fontSize="9.5" fill={isActive ? '#ECECEC' : '#6F6F6F'}>
                  {truncate(row.raw, 14)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
        {unitIndex.map((unit) => (
          <span key={unit} className="inline-flex items-center gap-1.5 text-[10.5px] text-[#8A8A8A]">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorOf(unit) }} />
            {unit === 'value' ? 'unitless' : unit}
          </span>
        ))}
      </div>
    </div>
  )
}

function SalienceVolumeChart({ sections }) {
  const [active, setActive] = useState(null)

  if (!sections.length) {
    return <Empty text="No section shares to compare yet. Run Auto-Iterate over the essay first." />
  }

  const width = 760
  const height = 300
  const pad = { top: 24, right: 18, bottom: 54, left: 38 }
  const plotWidth = width - pad.left - pad.right
  const plotHeight = height - pad.top - pad.bottom
  const groupWidth = plotWidth / sections.length
  const barWidth = Math.min(26, groupWidth * 0.3)
  const current = active != null ? sections[active] : null

  return (
    <div>
      <div className="mb-2 h-5 truncate text-[11.5px] text-[#8A8A8A]">
        {current ? (
          <span className="text-[#ECECEC]">
            {current.heading}{' '}
            <span className="text-[#8A8A8A]">
              · word share {fmtNumber(current.wordShare)}% · avg salience {fmtNumber(current.avgScore)}/10
            </span>
          </span>
        ) : (
          'Hover a section to compare technical density against filler volume'
        )}
      </div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full min-w-[620px]"
          role="img"
          aria-label="Word share versus semantic salience by section"
        >
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
            <g key={fraction}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={pad.top + plotHeight * (1 - fraction)}
                y2={pad.top + plotHeight * (1 - fraction)}
                stroke="#2F2F2F"
                strokeDasharray={fraction === 0 ? undefined : '2 4'}
                strokeWidth="1"
              />
              <text x={pad.left - 8} y={pad.top + plotHeight * (1 - fraction) + 3} textAnchor="end" fontSize="9" fill="#6F6F6F">
                {Math.round(fraction * 100)}%
              </text>
            </g>
          ))}
          {sections.map((section, index) => {
            const groupX = pad.left + index * groupWidth
            const volume = Math.max(0, Math.min(100, section.wordShare))
            const salience = Math.max(0, Math.min(100, section.avgScore * 10))
            const volumeHeight = (volume / 100) * plotHeight
            const salienceHeight = (salience / 100) * plotHeight
            const isActive = active === index
            const centre = groupX + groupWidth / 2
            return (
              <g
                key={`${section.heading}-${index}`}
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive(null)}
              >
                <rect x={groupX} y={pad.top} width={groupWidth} height={plotHeight} fill="transparent" />
                <rect
                  x={centre - barWidth - 2}
                  y={pad.top + plotHeight - volumeHeight}
                  width={barWidth}
                  height={Math.max(2, volumeHeight)}
                  rx="3"
                  fill="#34D399"
                  opacity={isActive ? 1 : 0.82}
                />
                <rect
                  x={centre + 2}
                  y={pad.top + plotHeight - salienceHeight}
                  width={barWidth}
                  height={Math.max(2, salienceHeight)}
                  rx="3"
                  fill="#22D3EE"
                  opacity={isActive ? 1 : 0.82}
                />
                <text x={centre} y={height - 30} textAnchor="middle" fontSize="9.5" fill={isActive ? '#ECECEC' : '#8A8A8A'}>
                  {truncate(section.heading, sections.length > 6 ? 9 : 14)}
                </text>
                <text x={centre - barWidth / 2 - 2} y={pad.top + plotHeight - volumeHeight - 5} textAnchor="middle" fontSize="8.5" fill="#6F6F6F">
                  {fmtNumber(volume)}%
                </text>
                <text x={centre + barWidth / 2 + 2} y={pad.top + plotHeight - salienceHeight - 5} textAnchor="middle" fontSize="8.5" fill="#6F6F6F">
                  {fmtNumber(salience / 10)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[10.5px] text-[#8A8A8A]">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#34D399]" /> raw word share
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#22D3EE]" /> avg salience (×10)
        </span>
      </div>
    </div>
  )
}

const tableCell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`

function StructuredTable({ sections, query }) {
  const [status, setStatus] = useState('')
  const rows = sections.map((section) => ({
    section: section.heading,
    entities: section.concepts.slice(0, 4),
    metrics: section.metrics,
    score: section.avgScore,
  }))

  const markdown = () =>
    [
      '| Section | Key Entities | Extracted Metrics | Salience |',
      '| --- | --- | --- | --- |',
      ...rows.map(
        (row) =>
          `| ${tableCell(row.section)} | ${tableCell(row.entities.join(', '))} | ${tableCell(row.metrics.join(', '))} | ${row.score || '—'} |`,
      ),
    ].join('\n')

  const csv = () =>
    [['Section', 'Key Entities', 'Extracted Metrics', 'Salience', 'Query'], ...rows.map((row) => [row.section, row.entities.join('; '), row.metrics.join('; '), row.score, query])]
      .map((columns) => columns.map(csvCell).join(','))
      .join('\n')

  const copy = async (kind) => {
    try {
      const value = kind === 'markdown' ? markdown() : csv()
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(value)
      setStatus(`Copied ${kind === 'markdown' ? 'Markdown' : 'CSV'}`)
    } catch {
      setStatus('Copy failed')
    }
    setTimeout(() => setStatus(''), 1800)
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11.5px] text-[#8A8A8A]">
          {rows.length} sections · {rows.reduce((sum, row) => sum + row.metrics.length, 0)} extracted metrics
        </p>
        <div className="flex items-center gap-2">
          {status ? <span className="text-[10.5px] text-[#34D399]">{status}</span> : null}
          <button
            type="button"
            onClick={() => copy('markdown')}
            className="rounded-full border border-[#2F2F2F] px-3 py-1.5 text-[11px] text-[#BDBDBD] transition hover:bg-[#2A2A2A] hover:text-[#ECECEC]"
          >
            Copy Markdown
          </button>
          <button
            type="button"
            onClick={() => copy('csv')}
            className="rounded-full border border-[#2F2F2F] px-3 py-1.5 text-[11px] text-[#BDBDBD] transition hover:bg-[#2A2A2A] hover:text-[#ECECEC]"
          >
            Copy CSV
          </button>
        </div>
      </div>
      {rows.length ? (
        <div className="overflow-x-auto rounded-xl border border-[#2A2A2A]">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr className="bg-[#171717] text-[9.5px] uppercase tracking-[0.08em] text-[#7A7A7A]">
                <th className="px-3 py-2 font-medium">Section</th>
                <th className="px-3 py-2 font-medium">Key Entities</th>
                <th className="px-3 py-2 font-medium">Extracted Metrics</th>
                <th className="px-3 py-2 text-right font-medium">Salience</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.section}-${index}`} className="border-t border-[#2A2A2A] text-[11.5px] text-[#D4D4D4]">
                  <td className="max-w-[190px] px-3 py-2.5 align-top">{truncate(row.section, 40)}</td>
                  <td className="max-w-[240px] px-3 py-2.5 align-top text-[#BDBDBD]">
                    {row.entities.length ? row.entities.join(', ') : '—'}
                  </td>
                  <td className="max-w-[220px] px-3 py-2.5 align-top">
                    {row.metrics.length ? (
                      <span className="flex flex-wrap gap-1">
                        {row.metrics.map((metric) => (
                          <span key={metric} className="rounded-md bg-[#2A2A2A] px-1.5 py-0.5 font-mono text-[10px] text-[#34D399]">
                            {metric}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-[#6F6F6F]">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-[11px] text-[#8A8A8A]">
                    {row.score ? fmtNumber(row.score) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty text="No sections to tabulate yet." />
      )}
    </div>
  )
}

const ANALYTICS_VIEWS = [
  { id: 'metrics', label: 'Metric Comparison' },
  { id: 'salience', label: 'Salience vs. Volume' },
  { id: 'table', label: 'Structured Data Table' },
]

function AnalyticsSuite({ payload }) {
  const [view, setView] = useState('metrics')
  const sections = payload?.sections ?? []
  const numeric = payload?.numericSeries ?? []

  return (
    <section className="min-w-0 rounded-2xl border border-[#2F2F2F] bg-[#1E1E1E] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[13px] font-medium text-[#ECECEC]">Julius Analytics</h2>
          <p className="mt-0.5 text-[11.5px] text-[#8A8A8A]">
            {numeric.length} structured numeric points · {sections.length} section scores
          </p>
        </div>
        <div
          role="group"
          aria-label="Analytics view"
          className="inline-flex flex-wrap rounded-full border border-[#2F2F2F] bg-[#171717] p-1"
        >
          {ANALYTICS_VIEWS.map((option) => {
            const isActive = view === option.id
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={isActive}
                onClick={() => setView(option.id)}
                className={`rounded-full px-3 py-1.5 text-[11px] transition-colors ${
                  isActive ? 'bg-[#ECECEC] font-medium text-[#0D0D0D]' : 'text-[#9B9B9B] hover:text-[#ECECEC]'
                }`}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="mt-4">
        {view === 'metrics' ? <MetricComparisonChart points={numeric} /> : null}
        {view === 'salience' ? <SalienceVolumeChart sections={sections} /> : null}
        {view === 'table' ? <StructuredTable sections={sections} query={payload?.query ?? ''} /> : null}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Collision-free concept + flow map                                   */
/* ------------------------------------------------------------------ */

function buildGraph(payload, diagram) {
  const sections = payload?.sections ?? []
  const concepts = payload?.topConcepts ?? []
  const numeric = payload?.numericSeries ?? []

  if (!sections.length) {
    const rootNode = diagram?.nodes?.find((node) => node.group === 'question')
    const nodes = [
      { id: 'core', kind: 'core', label: rootNode?.label || payload?.query || 'Research topic', parent: null, score: 0 },
    ]
    const edges = []
    for (const node of diagram?.nodes ?? []) {
      if (node.group === 'question') continue
      nodes.push({ id: node.id, kind: 'concept', label: node.label, parent: 'core', score: 0, section: '' })
    }
    const inbound = new Set()
    for (const edge of diagram?.edges ?? []) {
      const from = edge.from === rootNode?.id ? 'core' : edge.from
      if (!nodes.some((node) => node.id === from) || !nodes.some((node) => node.id === edge.to)) continue
      inbound.add(edge.to)
      edges.push({
        from,
        to: edge.to,
        label: edge.label === 'traversed' ? 'leads to' : edge.label || '',
      })
    }
    for (const node of nodes.slice(1)) {
      if (!inbound.has(node.id)) edges.push({ from: 'core', to: node.id, label: 'leads to' })
    }
    return { nodes, edges }
  }

  const nodes = [
    { id: 'core', kind: 'core', label: payload?.query || 'Research topic', parent: null, score: null },
  ]
  const edges = []

  sections.slice(0, 4).forEach((section, sectionIndex) => {
    const sectionId = `s-${sectionIndex}`
    nodes.push({
      id: sectionId,
      kind: 'section',
      label: section.heading,
      parent: 'core',
      score: section.avgScore,
      section: section.heading,
      gripCount: section.gripCount,
    })
    edges.push({ from: 'core', to: sectionId, label: 'leads to' })

    const matched = concepts.filter((concept) => concept.sectionHeading === section.heading)
    const candidates = (matched.length
      ? matched
      : section.concepts.map((word) => ({ word, score: 0, sectionHeading: section.heading, snippets: [] }))
    ).slice(0, 2)
    candidates.forEach((concept, conceptIndex) => {
      const conceptId = `c-${sectionIndex}-${conceptIndex}`
      nodes.push({
        id: conceptId,
        kind: 'concept',
        label: concept.word,
        parent: sectionId,
        score: concept.score,
        section: section.heading,
        snippets: concept.snippets ?? [],
      })
      edges.push({ from: sectionId, to: conceptId, label: 'evidenced by' })
    })

    const points = numeric.filter((point) => point.sectionHeading === section.heading).slice(0, 1)
    points.forEach((point, pointIndex) => {
      const metricId = `m-${sectionIndex}-${pointIndex}`
      nodes.push({
        id: metricId,
        kind: 'metric',
        label: point.raw,
        parent: sectionId,
        score: section.avgScore,
        section: section.heading,
        unit: point.unit,
        snippets: [`${point.entity} — ${point.raw}`],
      })
      const owner = nodes.find(
        (node) =>
          node.kind === 'concept' &&
          node.section === section.heading &&
          node.label.toLowerCase() === String(point.entity).toLowerCase(),
      )
      edges.push({ from: owner?.id || sectionId, to: metricId, label: 'quantifies' })
    })
  })

  // Contrast the lead entities of the first two sections so the map surfaces
  // the trade-offs the crawler walked between.
  const conceptNodes = nodes.filter((node) => node.kind === 'concept')
  if (conceptNodes.length >= 2) {
    edges.push({ from: conceptNodes[0].id, to: conceptNodes[conceptNodes.length - 1].id, label: 'contrasts', dashed: true })
  }

  return { nodes, edges }
}

function layoutGraph(nodes, mode) {
  const width = mode === 'hub' ? 1000 : 920
  const nodeWidth = (node) => Math.max(88, Math.min(176, 26 + truncate(node.label).length * 6.1))
  const core = nodes.find((node) => node.kind === 'core') ?? nodes[0]
  const sections = nodes.filter((node) => node.kind === 'section')
  const children = nodes.filter((node) => node !== core && node.kind !== 'section')
  const positions = new Map()
  let height

  if (mode === 'hub') {
    height = 760
    const centre = { x: width / 2, y: height / 2 }
    if (core) positions.set(core.id, centre)
    const sector = sections.length ? (Math.PI * 2) / sections.length : Math.PI * 2
    const base = -Math.PI / 2
    sections.forEach((section, index) => {
      const angle = base + index * sector
      positions.set(section.id, { x: centre.x + Math.cos(angle) * 170, y: centre.y + Math.sin(angle) * 170 })
      const owned = children.filter((child) => child.parent === section.id)
      owned.forEach((child, childIndex) => {
        const spread = sector * 0.7
        const offset = owned.length === 1 ? 0 : (childIndex / (owned.length - 1) - 0.5) * spread
        const childAngle = angle + offset
        positions.set(child.id, {
          x: centre.x + Math.cos(childAngle) * 350,
          y: centre.y + Math.sin(childAngle) * 350,
        })
      })
    })
    const orphans = children.filter((child) => !child.parent || !positions.has(child.parent))
    orphans.forEach((child, index) => {
      const angle = base + (index / Math.max(1, orphans.length)) * Math.PI * 2
      positions.set(child.id, { x: centre.x + Math.cos(angle) * 240, y: centre.y + Math.sin(angle) * 240 })
    })
  } else {
    if (core) positions.set(core.id, { x: width / 2, y: 48 })
    sections.forEach((section, index) => {
      positions.set(section.id, { x: (index + 0.5) * (width / Math.max(1, sections.length)), y: 172 })
    })
    const perRow = 4
    children.forEach((child, index) => {
      const row = Math.floor(index / perRow)
      const column = index % perRow
      const count = Math.min(perRow, children.length - row * perRow)
      positions.set(child.id, { x: (column + 0.5) * (width / count), y: 312 + row * 94 })
    })
    const rows = Math.max(1, Math.ceil(children.length / perRow))
    height = Math.max(440, 312 + rows * 94)
  }

  const placed = nodes
    .filter((node) => positions.has(node.id))
    .map((node) => ({ ...node, w: nodeWidth(node), x: positions.get(node.id).x, y: positions.get(node.id).y }))

  return { width, height, nodes: relax(placed, width, height, mode === 'hub' ? 26 : 14) }
}

function relax(nodes, width, height, gap) {
  for (let iteration = 0; iteration < 160; iteration += 1) {
    let collision = false
    for (let a = 0; a < nodes.length; a += 1) {
      for (let b = a + 1; b < nodes.length; b += 1) {
        const first = nodes[a]
        const second = nodes[b]
        const dx = second.x - first.x
        const dy = second.y - first.y
        const overlapX = (first.w + second.w) / 2 + gap - Math.abs(dx)
        const overlapY = NODE_HEIGHT + gap - Math.abs(dy)
        if (overlapX <= 0 || overlapY <= 0) continue
        collision = true
        if (overlapY <= overlapX) {
          const push = overlapY / 2 + 0.5
          first.y -= dy >= 0 ? push : -push
          second.y += dy >= 0 ? push : -push
        } else {
          const push = overlapX / 2 + 0.5
          first.x -= dx >= 0 ? push : -push
          second.x += dx >= 0 ? push : -push
        }
      }
    }
    for (const node of nodes) {
      node.x = Math.min(width - node.w / 2 - 12, Math.max(node.w / 2 + 12, node.x))
      node.y = Math.min(height - NODE_HEIGHT / 2 - 10, Math.max(NODE_HEIGHT / 2 + 10, node.y))
    }
    if (!collision) break
  }
  return nodes
}

function connector(from, to, mode) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  const boundary = (node, target) => {
    const tx = target.x - node.x
    const ty = target.y - node.y
    const halfWidth = node.w / 2 + 3
    const halfHeight = NODE_HEIGHT / 2 + 3
    const scale = Math.min(halfWidth / Math.abs(tx || 1e-6), halfHeight / Math.abs(ty || 1e-6))
    return { x: node.x + tx * scale, y: node.y + ty * scale }
  }
  const start = boundary(from, to)
  const end = boundary(to, from)

  if (mode === 'hub') {
    const bulge = 0.16
    const control = {
      x: (start.x + end.x) / 2 - dy * bulge,
      y: (start.y + end.y) / 2 + dx * bulge,
    }
    return {
      d: `M${start.x.toFixed(1)},${start.y.toFixed(1)} Q${control.x.toFixed(1)},${control.y.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`,
      mid: { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 },
      length,
    }
  }

  const controlOne = { x: start.x, y: start.y + (end.y - start.y) * 0.5 }
  const controlTwo = { x: end.x, y: start.y + (end.y - start.y) * 0.5 }
  return {
    d: `M${start.x.toFixed(1)},${start.y.toFixed(1)} C${controlOne.x.toFixed(1)},${controlOne.y.toFixed(1)} ${controlTwo.x.toFixed(1)},${controlTwo.y.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`,
    mid: {
      x: (start.x + 3 * controlOne.x + 3 * controlTwo.x + end.x) / 8,
      y: (start.y + 3 * controlOne.y + 3 * controlTwo.y + end.y) / 8,
    },
    length,
  }
}

function strokeFor(node, selected) {
  if (selected) return '#ECECEC'
  if (node.kind === 'core') return '#34D399'
  if (node.kind === 'metric') return '#22D3EE'
  if (node.score >= 4.5) return node.kind === 'section' ? '#34D399' : '#22D3EE'
  return '#3A3A3A'
}

function NodeInspector({ node, payload }) {
  if (!node) {
    return (
      <p className="px-1 py-2 text-[11.5px] leading-5 text-[#8A8A8A]">
        Click any node to trace its incoming and outgoing paths, then read its crawled evidence here.
      </p>
    )
  }
  const section = payload?.sections?.find((candidate) => candidate.heading === node.section)
  const snippets = node.snippets?.length ? node.snippets : section?.summarySnippet ? [section.summarySnippet] : []

  return (
    <div className="rounded-xl border border-[#2F2F2F] bg-[#171717] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-[#2F2F2F] bg-[#212121] px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-wide text-[#34D399]">
          {node.kind}
        </span>
        <h3 className="min-w-0 break-words text-[13px] font-medium text-[#ECECEC]">{node.label}</h3>
      </div>
      <dl className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-[9.5px] uppercase tracking-[0.08em] text-[#7A7A7A]">Salience</dt>
          <dd className="mt-1 font-mono text-[12px] text-[#D4D4D4]">
            {Number.isFinite(node.score) && node.score > 0 ? fmtNumber(node.score) : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-[9.5px] uppercase tracking-[0.08em] text-[#7A7A7A]">Parent section</dt>
          <dd className="mt-1 truncate text-[12px] text-[#D4D4D4]" title={node.section || ''}>
            {node.section || '—'}
          </dd>
        </div>
        <div>
          <dt className="text-[9.5px] uppercase tracking-[0.08em] text-[#7A7A7A]">{node.unit ? 'Extracted unit' : 'Section grips'}</dt>
          <dd className="mt-1 font-mono text-[12px] text-[#D4D4D4]">
            {node.unit ? node.unit || 'unitless' : section?.gripCount ?? node.gripCount ?? '—'}
          </dd>
        </div>
      </dl>
      <div className="mt-3">
        <p className="text-[9.5px] uppercase tracking-[0.08em] text-[#7A7A7A]">Crawled word snippets</p>
        {snippets.length ? (
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {snippets.map((snippet, index) => (
              <li
                key={`${snippet}-${index}`}
                className="max-w-full truncate rounded-md bg-[#212121] px-2 py-1 font-mono text-[10.5px] text-[#BDBDBD]"
                title={snippet}
              >
                {snippet}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-[11.5px] text-[#6F6F6F]">No word-level snippets were captured for this node.</p>
        )}
      </div>
    </div>
  )
}

function ConceptGraphPanel({ payload, diagram }) {
  const [mode, setMode] = useState('flow')
  const [selectedId, setSelectedId] = useState(null)
  const graph = useMemo(() => buildGraph(payload, diagram), [payload, diagram])
  const layout = useMemo(() => layoutGraph(graph.nodes, mode), [graph.nodes, mode])
  const byId = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout.nodes])
  const selected = selectedId ? byId.get(selectedId) ?? null : null
  const connected = useMemo(() => {
    if (!selectedId) return null
    const ids = new Set([selectedId])
    for (const edge of graph.edges) {
      if (edge.from === selectedId) ids.add(edge.to)
      if (edge.to === selectedId) ids.add(edge.from)
    }
    return ids
  }, [graph.edges, selectedId])

  const connectors = graph.edges
    .map((edge) => {
      const from = byId.get(edge.from)
      const to = byId.get(edge.to)
      if (!from || !to) return null
      return { edge, ...connector(from, to, mode) }
    })
    .filter(Boolean)

  const modes = [
    { id: 'flow', label: 'Directed Flow' },
    { id: 'hub', label: 'Cluster Hub' },
  ]

  return (
    <section className="min-w-0 rounded-2xl border border-[#2F2F2F] bg-[#1E1E1E] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[13px] font-medium text-[#ECECEC]">Napkin Concept &amp; Flow Map</h2>
          <p className="mt-0.5 text-[11.5px] text-[#8A8A8A]">
            Core topic → prioritised sections → quantitative evidence, with collision-free pills and labelled edges
          </p>
        </div>
        <div role="group" aria-label="Map layout" className="inline-flex rounded-full border border-[#2F2F2F] bg-[#171717] p-1">
          {modes.map((option) => {
            const isActive = mode === option.id
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={isActive}
                onClick={() => setMode(option.id)}
                className={`rounded-full px-3 py-1.5 text-[11px] transition-colors ${
                  isActive ? 'bg-[#ECECEC] font-medium text-[#0D0D0D]' : 'text-[#9B9B9B] hover:text-[#ECECEC]'
                }`}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>

      {layout.nodes.length <= 1 ? (
        <div className="mt-4">
          <Empty text="No crawled structure yet. Run Auto-Iterate so the spider can harvest sections, entities and metrics for this map." />
        </div>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto rounded-xl border border-[#2A2A2A] bg-[#171717] p-2">
            <svg
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              className="h-auto w-full min-w-[680px]"
              style={{ minHeight: 420 }}
              role="img"
              aria-label="Concept and flow map"
              onClick={(event) => {
                if (event.target === event.currentTarget) setSelectedId(null)
              }}
            >
              {connectors.map(({ edge, d, mid, length }, index) => {
                const isConnected = !connected || (connected.has(edge.from) && connected.has(edge.to))
                const showBadge = Boolean(edge.label) && length > 96
                const badgeWidth = edge.label.length * 4.9 + 12
                return (
                  <g key={`edge-${index}`} opacity={isConnected ? 1 : 0.22}>
                    <path
                      d={d}
                      fill="none"
                      stroke={edge.dashed ? '#3F3F46' : isConnected && connected ? '#34D399' : '#3A3A3A'}
                      strokeWidth={isConnected && connected ? 1.6 : 1.1}
                      strokeDasharray={edge.dashed ? '5 5' : undefined}
                    />
                    {showBadge ? (
                      <g transform={`translate(${mid.x - badgeWidth / 2}, ${mid.y - 8})`}>
                        <rect
                          width={badgeWidth}
                          height="16"
                          rx="8"
                          fill="#171717"
                          stroke={isConnected && connected ? '#34D399' : '#2F2F2F'}
                          strokeOpacity={isConnected ? 1 : 0.5}
                        />
                        <text x={badgeWidth / 2} y="11" textAnchor="middle" fontSize="8.5" fill={isConnected ? '#BDBDBD' : '#6F6F6F'}>
                          {edge.label}
                        </text>
                      </g>
                    ) : null}
                  </g>
                )
              })}
              {layout.nodes.map((node) => {
                const isSelected = node.id === selectedId
                const dimmed = connected ? !connected.has(node.id) : false
                const isCore = node.kind === 'core'
                return (
                  <g
                    key={node.id}
                    className="cursor-pointer"
                    opacity={dimmed ? 0.45 : 1}
                    onClick={(event) => {
                      event.stopPropagation()
                      setSelectedId(isSelected ? null : node.id)
                    }}
                  >
                    <rect
                      x={node.x - node.w / 2}
                      y={node.y - NODE_HEIGHT / 2}
                      width={node.w}
                      height={NODE_HEIGHT}
                      rx="11"
                      fill="#1E1E1E"
                      stroke={strokeFor(node, isSelected)}
                      strokeWidth={isSelected ? 2 : 1}
                    />
                    <text
                      x={node.x}
                      y={node.y - 1.5}
                      textAnchor="middle"
                      fontSize={isCore ? 10.5 : 10}
                      fill={isCore ? '#ECECEC' : '#D4D4D4'}
                    >
                      {truncate(node.label)}
                    </text>
                    <text x={node.x} y={node.y + 12} textAnchor="middle" fontSize="8.5" fill="#7A7A7A">
                      {isCore
                        ? 'core topic'
                        : node.kind === 'metric'
                          ? `metric · ${node.unit || 'value'}`
                          : `${node.kind} · ★ ${fmtNumber(node.score || 0)}`}
                    </text>
                    <title>
                      {`${node.label}${node.section ? ` — ${node.section}` : ''}${
                        Number.isFinite(node.score) && node.score > 0 ? ` (salience ${node.score})` : ''
                      }`}
                    </title>
                  </g>
                )
              })}
            </svg>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10.5px] text-[#7A7A7A]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#34D399]" /> emerald = high salience
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#22D3EE]" /> cyan = concept / metric
            </span>
            <span>{graph.edges.length} semantic edges · click a node to inspect</span>
          </div>
          <div className="mt-3">
            <NodeInspector node={selected} payload={payload} />
          </div>
        </>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Payload bar                                                         */
/* ------------------------------------------------------------------ */

function PayloadBar({ payload, scope, busy, research, onRegenerate }) {
  const stats = payload?.stats ?? { sections: 0, concepts: 0, metrics: 0, grips: 0 }
  const hasPayload = stats.sections > 0 || stats.concepts > 0
  const options = [
    { id: 'spider', label: 'Spider-Crawled Focus' },
    { id: 'full', label: 'Full Essay Text' },
  ]

  return (
    <section aria-label="Crawled semantic payload" className="rounded-2xl border border-[#2F2F2F] bg-[#1A1A1A] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[12.5px] font-medium text-[#ECECEC]">Crawled Semantic Payload</h2>
            <span className="rounded-full border border-[#2F2F2F] bg-[#171717] px-2 py-0.5 font-mono text-[10px] text-[#9B9B9B]">
              spider memory
            </span>
            {busy ? <span className="text-[10.5px] text-[#38BDF8]">refreshing charts…</span> : null}
          </div>
          <p className="mt-1 text-[11.5px] leading-5 text-[#9B9B9B]">
            {hasPayload
              ? `${stats.sections} sections · ${stats.concepts} concepts · ${stats.metrics} numeric metrics · ${stats.grips} grips foraged`
              : 'No structure foraged yet. Running Auto-Iterate fills this payload as the spider walks the essay.'}
          </p>
          {hasPayload && payload.topConcepts.length ? (
            <p className="mt-1 truncate text-[11px] text-[#6F6F6F]">
              Top: {payload.topConcepts.slice(0, 6).map((item) => item.word).join(' · ')}
            </p>
          ) : null}
        </div>
        <div
          role="group"
          aria-label="Chart grounding"
          className="inline-flex shrink-0 rounded-full border border-[#2F2F2F] bg-[#171717] p-1"
        >
          {options.map((option) => {
            const active = scope === option.id
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  if (!active) onRegenerate?.(option.id)
                }}
                disabled={!research || busy}
                className={`rounded-full px-3 py-1.5 text-[11.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  active ? 'bg-[#ECECEC] font-medium text-[#0D0D0D]' : 'text-[#9B9B9B] hover:text-[#ECECEC]'
                }`}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>
      {hasPayload ? (
        <details className="mt-3">
          <summary className="cursor-pointer select-none text-[11.5px] text-[#9B9B9B] transition hover:text-[#ECECEC]">
            View the markdown digest handed to the generators
          </summary>
          <pre className="mt-2 max-h-[180px] overflow-auto whitespace-pre-wrap rounded-xl bg-[#171717] p-3 font-mono text-[10.5px] leading-[1.7] text-[#BDBDBD]">
            {payload.formattedContext}
          </pre>
        </details>
      ) : null}
    </section>
  )
}

function Skeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {[0, 1, 2].map((key) => (
        <div key={key} className="h-[300px] animate-pulse rounded-2xl border border-[#2F2F2F] bg-[#212121]" />
      ))}
    </div>
  )
}

export default function JuliusNapkin({ visuals, busy, error, research, spiderMemory, scope = 'spider', onRegenerate }) {
  const payloadBar = (
    <PayloadBar payload={spiderMemory} scope={scope} busy={busy} research={research} onRegenerate={onRegenerate} />
  )

  if (busy && !visuals) {
    return (
      <div className="flex flex-col gap-4">
        {payloadBar}
        <Skeleton />
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-[#2F2F2F] bg-[#212121] p-6">
        <h2 className="text-[14px] font-medium text-[#ECECEC]">Charts could not be generated</h2>
        <p className="mt-1.5 text-[12.5px] leading-6 text-[#9B9B9B]">{error}</p>
      </div>
    )
  }

  if (!visuals) {
    return (
      <div className="flex flex-col gap-4">
        {payloadBar}
        <div className="rounded-2xl border border-[#2F2F2F] bg-[#212121] p-6">
          <h2 className="text-[14px] font-medium text-[#ECECEC]">Waiting for research</h2>
          <p className="mt-1.5 max-w-[520px] text-[12.5px] leading-6 text-[#9B9B9B]">
            {research
              ? 'Charts are generated as soon as the current research finishes.'
              : 'Start a question or paste a URL. When the research completes, Rivet builds the charts and the concept map automatically.'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {payloadBar}
      <div className="rounded-2xl border border-[#2F2F2F] bg-[#212121] p-5">
        <h1 className="text-[15px] font-medium text-[#ECECEC]">Julius &amp; Napkin</h1>
        <p className="mt-1 text-[12.5px] leading-6 text-[#9B9B9B]">
          {visuals.summary || 'Charts generated from the last research run.'}
        </p>
      </div>

      <KpiStrip payload={spiderMemory} />
      <Takeaways payload={spiderMemory} />
      <AnalyticsSuite payload={spiderMemory} />
      <ConceptGraphPanel payload={spiderMemory} diagram={visuals.diagram} />

      <p className="px-1 text-[11.5px] leading-5 text-[#9B9B9B]">
        Source: {visuals.source || research?.source || 'research'}
      </p>
    </div>
  )
}
