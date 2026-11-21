import { useState } from 'react'
import { downloadCSV } from '../lib/api.js'

const SLATE = ['#94A3B8', '#64748B', '#38BDF8', '#475569', '#CBD5E1', '#334155']

function Card({ title, meta, series, filename, children }) {
  const exportable = (series || []).map((point) => ({ Label: point.label, Value: point.value }))
  return (
    <section className="min-w-0 rounded-2xl border border-[#2F2F2F] bg-[#212121] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-medium text-[#ECECEC]">{title}</h2>
          <p className="mt-0.5 text-[11.5px] text-[#9B9B9B]">{meta}</p>
        </div>
        {exportable.length ? (
          <button
            type="button"
            onClick={() => downloadCSV(exportable, filename)}
            className="rounded-full border border-[#2F2F2F] px-3 py-1.5 text-[11.5px] text-[#9B9B9B] transition hover:bg-[#2A2A2A] hover:text-[#ECECEC]"
          >
            Download CSV
          </button>
        ) : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}

function BarChart({ series }) {
  const [active, setActive] = useState(null)
  const max = Math.max(1, ...series.map((point) => point.value))
  const width = 480
  const height = 220
  const pad = { top: 18, right: 12, bottom: 46, left: 12 }
  const plotWidth = width - pad.left - pad.right
  const plotHeight = height - pad.top - pad.bottom
  const step = plotWidth / Math.max(1, series.length)
  const barWidth = Math.min(46, step * 0.56)
  const current = active != null ? series[active] : null

  return (
    <div>
      <div className="mb-2 h-5 text-[12px] text-[#9B9B9B]">
        {current ? (
          <span className="text-[#ECECEC]">
            {current.label} <span className="text-[#9B9B9B]">· {current.value} mentions</span>
          </span>
        ) : (
          'Hover a bar for its value'
        )}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Term frequency bar chart">
        {[0.25, 0.5, 0.75, 1].map((fraction) => (
          <line
            key={fraction}
            x1={pad.left}
            x2={width - pad.right}
            y1={pad.top + plotHeight * (1 - fraction)}
            y2={pad.top + plotHeight * (1 - fraction)}
            stroke="#2F2F2F"
            strokeWidth="1"
          />
        ))}
        {series.map((point, index) => {
          const x = pad.left + index * step + (step - barWidth) / 2
          const barHeight = Math.max(2, (point.value / max) * plotHeight)
          const y = pad.top + plotHeight - barHeight
          const isActive = active === index
          return (
            <g key={`${point.label}-${index}`} onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)}>
              <rect x={x} y={pad.top} width={barWidth} height={plotHeight} fill="transparent" />
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx="4"
                fill={isActive ? '#38BDF8' : '#64748B'}
                className="transition-[fill] duration-150"
              />
              <text
                x={x + barWidth / 2}
                y={height - 24}
                textAnchor="middle"
                fontSize="10.5"
                fill={isActive ? '#ECECEC' : '#9B9B9B'}
              >
                {point.label.length > 12 ? `${point.label.slice(0, 11)}…` : point.label}
              </text>
              <text x={x + barWidth / 2} y={y - 6} textAnchor="middle" fontSize="10" fill="#9B9B9B">
                {point.value}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function LineChart({ series }) {
  const [active, setActive] = useState(null)
  const max = Math.max(1, ...series.map((point) => point.value))
  const width = 480
  const height = 220
  const pad = { top: 20, right: 16, bottom: 34, left: 16 }
  const plotWidth = width - pad.left - pad.right
  const plotHeight = height - pad.top - pad.bottom
  const points = series.map((point, index) => ({
    ...point,
    x: pad.left + (series.length === 1 ? plotWidth / 2 : (index / (series.length - 1)) * plotWidth),
    y: pad.top + plotHeight - (point.value / max) * plotHeight,
  }))
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
  const area = `${path} L${points[points.length - 1]?.x ?? pad.left},${pad.top + plotHeight} L${points[0]?.x ?? pad.left},${pad.top + plotHeight} Z`
  const current = active != null ? series[active] : null

  return (
    <div>
      <div className="mb-2 h-5 text-[12px] text-[#9B9B9B]">
        {current ? (
          <span className="text-[#ECECEC]">
            {current.label} <span className="text-[#9B9B9B]">· {current.value}% signal</span>
          </span>
        ) : (
          'Hover a point to inspect a decile'
        )}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Signal density line chart">
        {[0.25, 0.5, 0.75, 1].map((fraction) => (
          <line
            key={fraction}
            x1={pad.left}
            x2={width - pad.right}
            y1={pad.top + plotHeight * (1 - fraction)}
            y2={pad.top + plotHeight * (1 - fraction)}
            stroke="#2F2F2F"
            strokeWidth="1"
          />
        ))}
        <path d={area} fill="rgba(56,189,248,0.08)" />
        <path d={path} fill="none" stroke="#94A3B8" strokeWidth="1.8" strokeLinejoin="round" />
        {points.map((point, index) => (
          <g key={`${point.label}-${index}`} onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)}>
            <circle cx={point.x} cy={point.y} r="12" fill="transparent" />
            <circle
              cx={point.x}
              cy={point.y}
              r={active === index ? 4.6 : 3.2}
              fill={active === index ? '#38BDF8' : '#171717'}
              stroke={active === index ? '#38BDF8' : '#94A3B8'}
              strokeWidth="1.6"
            />
          </g>
        ))}
        {points.map((point, index) =>
          index % 2 === 0 || series.length <= 6 ? (
            <text key={`label-${index}`} x={point.x} y={height - 14} textAnchor="middle" fontSize="9.5" fill="#6F6F6F">
              {point.label}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  )
}

function Breakdown({ series }) {
  const [active, setActive] = useState(null)
  const total = Math.max(1, series.reduce((sum, point) => sum + point.value, 0))
  let offset = 0
  const parts = series.map((point, index) => {
    const share = (point.value / total) * 100
    const part = { ...point, share, offset, color: SLATE[index % SLATE.length] }
    offset += share
    return part
  })

  return (
    <div>
      <div className="flex h-9 w-full overflow-hidden rounded-lg bg-[#171717]">
        {parts.map((part, index) => (
          <div
            key={`${part.label}-${index}`}
            onMouseEnter={() => setActive(index)}
            onMouseLeave={() => setActive(null)}
            title={`${part.label}: ${part.value} words (${part.share.toFixed(1)}%)`}
            style={{ width: `${part.share}%`, backgroundColor: part.color, opacity: active == null || active === index ? 1 : 0.45 }}
            className="h-full transition-opacity duration-150 first:rounded-l-lg last:rounded-r-lg"
          />
        ))}
      </div>
      <div className="mt-4 space-y-2">
        {parts.map((part, index) => (
          <div
            key={`legend-${index}`}
            onMouseEnter={() => setActive(index)}
            onMouseLeave={() => setActive(null)}
            className={`flex items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors ${
              active === index ? 'bg-[#2A2A2A]' : ''
            }`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: part.color }} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#ECECEC]">{part.label}</span>
            <span className="shrink-0 text-[11.5px] text-[#9B9B9B]">
              {part.value.toLocaleString()} words · {part.share.toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ConceptMap({ diagram }) {
  const width = 520
  const height = 320
  const centre = { x: width / 2, y: height / 2 }
  const concepts = diagram.nodes.filter((node) => node.group !== 'question')
  const positions = new Map()
  diagram.nodes.forEach((node) => {
    if (node.group === 'question') {
      positions.set(node.id, centre)
      return
    }
    const index = concepts.findIndex((item) => item.id === node.id)
    const angle = -Math.PI / 2 + (index / Math.max(1, concepts.length)) * Math.PI * 2
    const radius = 112
    positions.set(node.id, { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius })
  })

  const wrap = (label, size) => (label.length > 20 ? `${label.slice(0, size)}…` : label)

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Concept map">
      {diagram.edges.map((edge, index) => {
        const from = positions.get(edge.from)
        const to = positions.get(edge.to)
        if (!from || !to) return null
        return (
          <line
            key={`edge-${index}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke={edge.label ? '#3A3A3A' : '#2F2F2F'}
            strokeWidth="1.2"
          />
        )
      })}
      {diagram.nodes.map((node) => {
        const point = positions.get(node.id)
        if (!point) return null
        const isQuestion = node.group === 'question'
        const nodeWidth = isQuestion ? 150 : 116
        const nodeHeight = isQuestion ? 54 : 38
        return (
          <g key={node.id}>
            <rect
              x={point.x - nodeWidth / 2}
              y={point.y - nodeHeight / 2}
              width={nodeWidth}
              height={nodeHeight}
              rx="12"
              fill={isQuestion ? '#2A2A2A' : '#171717'}
              stroke={isQuestion ? '#38BDF8' : '#2F2F2F'}
              strokeWidth="1.2"
            />
            <text
              x={point.x}
              y={point.y + 4}
              textAnchor="middle"
              fontSize={isQuestion ? 11.5 : 10.5}
              fill={isQuestion ? '#ECECEC' : '#9B9B9B'}
            >
              {wrap(node.label, isQuestion ? 20 : 16)}
            </text>
          </g>
        )
      })}
    </svg>
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

export default function JuliusNapkin({ visuals, busy, error, research }) {
  if (busy) return <Skeleton />

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
      <div className="rounded-2xl border border-[#2F2F2F] bg-[#212121] p-6">
        <h2 className="text-[14px] font-medium text-[#ECECEC]">Waiting for research</h2>
        <p className="mt-1.5 max-w-[520px] text-[12.5px] leading-6 text-[#9B9B9B]">
          {research
            ? 'Charts are generated as soon as the current research finishes.'
            : 'Start a question or paste a URL. When the research completes, WebPilot builds the charts and the concept map automatically.'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-[#2F2F2F] bg-[#212121] p-5">
        <h1 className="text-[15px] font-medium text-[#ECECEC]">Julius &amp; Napkin</h1>
        <p className="mt-1 text-[12.5px] leading-6 text-[#9B9B9B]">
          {visuals.summary || 'Charts generated from the last research run.'}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title={visuals.bar?.title || 'Term frequency'}
          meta={`${visuals.bar?.series?.length || 0} terms · mentions`}
          series={visuals.bar?.series}
          filename="webpilot-term-frequency.csv"
        >
          <BarChart series={visuals.bar?.series || []} />
        </Card>

        <Card
          title={visuals.line?.title || 'Signal density'}
          meta="Share of signal-bearing words per reading decile"
          series={visuals.line?.series}
          filename="webpilot-signal-density.csv"
        >
          <LineChart series={visuals.line?.series || []} />
        </Card>

        <Card
          title={visuals.breakdown?.title || 'Section mix'}
          meta={`${visuals.breakdown?.series?.length || 0} sections · words`}
          series={visuals.breakdown?.series}
          filename="webpilot-section-mix.csv"
        >
          <Breakdown series={visuals.breakdown?.series || []} />
        </Card>

        <Card title="Concept map" meta="Entities linked to the research question">
          <ConceptMap diagram={visuals.diagram || { nodes: [], edges: [] }} />
        </Card>
      </div>

      <p className="px-1 text-[11.5px] leading-5 text-[#9B9B9B]">
        Source: {visuals.source || research?.source || 'research'}
      </p>
    </div>
  )
}
