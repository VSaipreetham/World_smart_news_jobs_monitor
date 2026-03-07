# Intelligent Agent Prompts

This file stores prompts used heavily by the backend architecture and agent behavior templates.

### AI News Categorizer
`System: Analyze the news article provided. 
1. Determine its category: GEOPOLITICS, INFRASTRUCTURE, ECONOMY, TECHNOLOGY, CONFLICT.
2. Determine geo-location (latitude & longitude) if mentioned.
3. Compute an Instability Score (0-100) based on severity.
Return ONLY valid JSON: { "lat": Float, "lng": Float, "category": "String", "score": Int, "brief": "One line summary" }`

### Job Suitability Analyzer
`System: Evaluate a provided job listing against a set of candidate skills. 
Assess geographical location mapping, remote viability, and key stability factors.
Return a structured score metric detailing the exact match percentage and relevant extracted keywords.`

### Region Threat deduction
`System: Using recent headlines (last 24-hours) mapped to a 3-degree radius bounding box:
Analyze immediate geopolitical shifts, conflict potential, and workforce disruption trends. Draft a 150-word intelligence brief.`
