You are editing an existing React psychoeducational report generator app. The app already works with WISC V narrative generation and uses OpenAI through an existing aiGen function. You will add WAIS IV logic for students age 16 years 0 months or older, and WPPSI IV logic for students younger than 6 years 0 months.

You will not change anything else.

You will not change OpenAI integration, aiGen, WISC V templates, appendix logic beyond tool selection alignment, section ordering, writing style, tone, formatting, or any non cognitive sections. You will only add age based selection, WAIS IV and WPPSI IV templates, manual score entry storage, and generation routing.

Input you will receive
1. The full current App 2.jsx file content from me in this same message, below this instruction block.
2. You must output the full updated App 2.jsx file as a single code block.

Core decision rules
1. If age at testing is 16 years 0 months or older, cognitive section uses WAIS IV and the app marks WAIS IV used in Tools, and marks WISC V and WPPSI IV unused.
2. If age at testing is younger than 6 years 0 months, cognitive section uses WPPSI IV and the app marks WPPSI IV used in Tools, and marks WISC V and WAIS IV unused.
3. If age at testing is 6 years 0 months to 15 years 11 months, cognitive section uses existing WISC V logic with no changes.

Implementation requirements
A. Add an age parser that reads meta.ageAtTesting which typically looks like “10 years, 2 months” or “5 years 11 months” and returns total months.
B. Add two deterministic narrative templates, WAIS IV and WPPSI IV, that match the existing WISC V narrative style. They must use the same overall paragraph based approach and cautious professional phrasing. They must keep wording simple and consistent.
C. Add manual score entry UI shown only when the relevant age rule triggers.
D. Store WAIS manual data at secs.cognitive.waisManual and WPPSI manual data at secs.cognitive.wppsiManual.
E. Generation routing must occur inside the existing cognitive generate flow. It must run before the existing WISC V logic. It must return early only when it successfully generates WAIS or WPPSI content.
F. If required manual fields remain missing, you must not generate partial text. Instead show a toast listing the missing fields and keep existing cognitive content unchanged.
G. Do not remove or rename any existing variables, helpers, or state keys.
H. Keep existing deterministic helpers such as personalize and capitalizeSentences and reuse them.

WAIS IV required fields
FSIQ score and percentile
VCI score and percentile
PRI score and percentile
WMI score and percentile
PSI score and percentile
Optional strengths text
Optional weakerAreas text

WPPSI IV required fields
FSIQ score and percentile
VCI score and percentile
VSI score and percentile
FRI score and percentile
WMI score and percentile
PSI score and percentile
Optional strengths text
Optional weakerAreas text

Descriptor mapping
Use percentile to descriptor mapping. Use exact labels.
Percentile 98 to 99 Very High
Percentile 91 to 97 High
Percentile 75 to 90 Above Average
Percentile 25 to 74 Average
Percentile 9 to 24 Low Average
Percentile 3 to 8 Low
Percentile 1 to 2 Very Low

Templates

WAIS IV cognitive template must output exactly this section structure and headings, matching the WISC style.
It must include these headings as plain text lines.
Cognitive Functioning
Verbal Comprehension
Perceptual Reasoning
Working Memory
Processing Speed
Cognitive Profile Summary

WAIS IV template content rules
1. Intro paragraph describes WAIS IV and mentions standard scores mean 100 and standard deviation 15 and percentiles.
2. FSIQ paragraph includes score and percentile and descriptor. Use “At the present moment,”.
3. Each index paragraph includes score, percentile, descriptor, one sentence describing what it assesses, and one sentence describing how it may show as a relative strength or somewhat weaker at times. Keep cautious phrasing.
4. Summary paragraph mentions variability, strengths, weaker areas, and connects to learning and efficiency.

Use this WAIS IV exact template text with placeholders:

WAIS_COG_TEMPLATE = `Cognitive Functioning

The Wechsler Adult Intelligence Scale, Fourth Edition (WAIS-IV), was administered to assess overall cognitive functioning. The WAIS-IV provides a Full Scale IQ (FSIQ), which represents an estimate of overall intellectual ability, as well as index scores that reflect specific areas of cognitive functioning, including Verbal Comprehension, Perceptual Reasoning, Working Memory, and Processing Speed. Scores are reported as standard scores with a mean of 100 and a standard deviation of 15. Percentile ranks indicate how performance compares to same age peers.

At the present moment, [firstName] obtained a Full Scale IQ score of [FSIQ_SCORE] ([FSIQ_PERCENTILE] percentile), which falls within the [FSIQ_DESCRIPTOR] range.

Verbal Comprehension

The Verbal Comprehension Index (VCI) assesses verbal reasoning, concept formation, and access to acquired knowledge. [firstName] obtained a VCI score of [VCI_SCORE] ([VCI_PERCENTILE] percentile), which falls within the [VCI_DESCRIPTOR] range. This pattern suggests that verbal reasoning represents an area of [VCI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require understanding and explaining ideas using language.

Perceptual Reasoning

The Perceptual Reasoning Index (PRI) assesses nonverbal reasoning and visual analysis. [firstName] obtained a PRI score of [PRI_SCORE] ([PRI_PERCENTILE] percentile), which falls within the [PRI_DESCRIPTOR] range. This pattern suggests that visual reasoning represents an area of [PRI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require solving novel problems using visual information.

Working Memory

The Working Memory Index (WMI) assesses attention and the ability to hold and use information over short periods of time. [firstName] obtained a WMI score of [WMI_SCORE] ([WMI_PERCENTILE] percentile), which falls within the [WMI_DESCRIPTOR] range. This pattern suggests that working memory represents an area of [WMI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require following multi step instructions or mentally manipulating information.

Processing Speed

The Processing Speed Index (PSI) assesses the efficiency of scanning and responding to simple visual information under structured conditions. [firstName] obtained a PSI score of [PSI_SCORE] ([PSI_PERCENTILE] percentile), which falls within the [PSI_DESCRIPTOR] range. This pattern suggests that processing efficiency represents an area of [PSI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require quick visual attention and consistent pace.

Cognitive Profile Summary

Overall, [firstName] demonstrates cognitive functioning within the [FSIQ_DESCRIPTOR] range, with variability observed across domains. Relative strengths were observed in [WAIS_STRENGTHS]. Areas of somewhat weaker performance were observed in [WAIS_WEAKER_AREAS]. This profile suggests that [firstName] may show stronger learning efficiency when tasks align with relative strengths, and may require additional time or support at times when tasks place heavier demands on relative weaker areas.`;

WPPSI IV cognitive template must output exactly this section structure and headings, matching the WISC style.
It must include these headings as plain text lines.
Cognitive Functioning
Verbal Comprehension
Visual Spatial
Fluid Reasoning
Working Memory
Processing Speed
Cognitive Profile Summary

WPPSI IV template content rules
1. Intro paragraph describes WPPSI IV and mentions standard scores mean 100 and standard deviation 15 and percentiles.
2. FSIQ paragraph includes score and percentile and descriptor. Use “At the present moment,”.
3. Each index paragraph includes score, percentile, descriptor, one sentence describing what it assesses in age appropriate terms, and one sentence describing how it may show as a relative strength or somewhat weaker at times.
4. Summary paragraph mentions variability, strengths, weaker areas, and connects to learning in structured settings.

Use this WPPSI IV exact template text with placeholders:

WPPSI_COG_TEMPLATE = `Cognitive Functioning

The Wechsler Preschool and Primary Scale of Intelligence, Fourth Edition (WPPSI-IV), was administered to assess overall cognitive functioning. The WPPSI-IV provides a Full Scale IQ (FSIQ), which represents an estimate of overall intellectual ability, as well as index scores that reflect specific areas of early cognitive development. Scores are reported as standard scores with a mean of 100 and a standard deviation of 15. Percentile ranks indicate how performance compares to same age peers.

At the present moment, [firstName] obtained a Full Scale IQ score of [FSIQ_SCORE] ([FSIQ_PERCENTILE] percentile), which falls within the [FSIQ_DESCRIPTOR] range.

Verbal Comprehension

The Verbal Comprehension Index (VCI) assesses early verbal reasoning and understanding of language based concepts. [firstName] obtained a VCI score of [VCI_SCORE] ([VCI_PERCENTILE] percentile), which falls within the [VCI_DESCRIPTOR] range. This pattern suggests that language based reasoning represents an area of [VCI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require understanding words and explaining ideas.

Visual Spatial

The Visual Spatial Index (VSI) assesses the ability to understand and organize visual information. [firstName] obtained a VSI score of [VSI_SCORE] ([VSI_PERCENTILE] percentile), which falls within the [VSI_DESCRIPTOR] range. This pattern suggests that visual spatial skills represent an area of [VSI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require noticing details and working with shapes and patterns.

Fluid Reasoning

The Fluid Reasoning Index (FRI) assesses early problem solving with new information. [firstName] obtained a FRI score of [FRI_SCORE] ([FRI_PERCENTILE] percentile), which falls within the [FRI_DESCRIPTOR] range. This pattern suggests that early reasoning represents an area of [FRI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require finding rules or relationships.

Working Memory

The Working Memory Index (WMI) assesses attention and the ability to hold and use information for short periods of time. [firstName] obtained a WMI score of [WMI_SCORE] ([WMI_PERCENTILE] percentile), which falls within the [WMI_DESCRIPTOR] range. This pattern suggests that working memory represents an area of [WMI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require listening and remembering instructions.

Processing Speed

The Processing Speed Index (PSI) assesses the efficiency of noticing and responding to simple visual information under structured conditions. [firstName] obtained a PSI score of [PSI_SCORE] ([PSI_PERCENTILE] percentile), which falls within the [PSI_DESCRIPTOR] range. This pattern suggests that processing efficiency represents an area of [PSI_STRENGTH_OR_WEAKER] at the present moment, particularly when tasks require quick and steady responding.

Cognitive Profile Summary

Overall, [firstName] demonstrates cognitive functioning within the [FSIQ_DESCRIPTOR] range, with variability observed across domains. Relative strengths were observed in [WPPSI_STRENGTHS]. Areas of somewhat weaker performance were observed in [WPPSI_WEAKER_AREAS]. This profile suggests that [firstName] may show stronger learning efficiency in structured activities that align with relative strengths, and may require additional time or support at times when tasks place heavier demands on relative weaker areas.`;

Strength or weaker label logic
For each index, set the placeholder like [VCI_STRENGTH_OR_WEAKER] based on the index descriptor.
If descriptor is Very High, High, or Above Average, use “a relative strength”.
If descriptor is Average, use “an area of expected development”.
If descriptor is Low Average, Low, or Very Low, use “an area of somewhat weaker development”.

Manual entry UI requirements
1. In cognitive section UI, when useWAISByAge is true, render a WAIS manual entry panel with fields for scores and percentiles for FSIQ, VCI, PRI, WMI, PSI, plus strengths and weaker areas.
2. In cognitive section UI, when useWPPSIByAge is true, render a WPPSI manual entry panel with fields for scores and percentiles for FSIQ, VCI, VSI, FRI, WMI, PSI, plus strengths and weaker areas.
3. Keep styles consistent with existing input panels.

Generation functions
Add these helper functions that fill templates using personalize and capitalizeSentences.

1. percentileToDescriptor
2. descriptorToStrengthLabel
3. fillWAISCognitiveTemplate
4. fillWPPSICognitiveTemplate

Fill functions must:
• replace all placeholders
• call personalize(template, firstName, pronouns)
• then call capitalizeSentences
• use safe placeholder value “[score not available]” only for optional strengths and weaker areas, never for required numeric fields, because generation must stop if required fields missing.

Required field enforcement
Before generating WAIS, verify all WAIS required fields exist and contain values.
Before generating WPPSI, verify all WPPSI required fields exist and contain values.
If missing, showToast with one line that starts with “Missing fields:” followed by comma separated missing keys, then return without updating content.

Tools auto selection
Add a useEffect watching meta.ageAtTesting that sets tools used flags to match instrument based on age. Use tool ids:
wais-iv
wppsi-iv
wisc-v

If age indicates WAIS, set only wais-iv used true.
If age indicates WPPSI, set only wppsi-iv used true.
If age indicates WISC, set only wisc-v used true.

Output
Return only the full updated App 2.jsx file in one code block. No explanation.

Now I will paste App 2.jsx below. You will edit it accordingly.

PASTE APP 2.jsx HERE
