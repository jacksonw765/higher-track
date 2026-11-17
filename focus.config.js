// Everything that defines *what this dashboard watches* lives in this file.
// Edit it, restart the server, and press Refresh. Nothing else is agency- or topic-specific.

module.exports = {
  // Agencies whose notices are pulled from HigherGov and that get a page under "Agencies".
  //   key          HigherGov agency key (the number at the end of a HigherGov agency URL)
  //   aliases      Text that counts as a mention when another office posts on the agency's behalf
  //   usaspending  Exact USAspending sub-agency name, used for obligations, vendors, and PSC mix
  //   role         'funding' if the agency mostly pays for work other offices award,
  //                'awarding' if it is a contracting shop
  //   contracts    How many of its largest contracts to track for recompetes (0 = none)
  agencies: [
    {
      key: 479,
      label: 'CISA',
      name: 'Cybersecurity and Infrastructure Security Agency',
      aliases: ['CISA', 'Cybersecurity and Infrastructure Security Agency'],
      usaspending: 'Cybersecurity and Infrastructure Security Agency',
      role: 'funding',
      contracts: 100,
    },
    {
      key: 467,
      label: 'DHS OCPO',
      name: 'DHS Office of Procurement Operations',
      aliases: [],
      usaspending: 'Office of Procurement Operations',
      role: 'awarding',
      contracts: 50,
    },
    {
      key: 341,
      label: 'DISA',
      name: 'Defense Information Systems Agency',
      aliases: ['DISA', 'Defense Information Systems Agency'],
      usaspending: 'Defense Information Systems Agency',
      role: 'awarding',
      contracts: 50,
    },
    {
      key: 343,
      label: 'USCYBERCOM',
      name: 'U.S. Cyber Command',
      aliases: ['USCYBERCOM', 'CYBERCOM', 'Cyber Command'],
      usaspending: 'U.S. Cyber Command',
      role: 'funding',
      contracts: 50,
    },

    // Watch-only agencies: their notices are pulled and filterable, but they get no page under
    // "Agencies" and no contract pull, which keeps the HigherGov record cost down. To promote one,
    // drop `page: false` and add `usaspending`, `role` and `contracts` as above.
    //   days   How far back to pull notices (defaults to the global look-back)
    // HigherGov files a notice under the exact office that posted it, so "Army" is only what the
    // department itself posts, not every Army command.
    { key: 474, label: 'DHS OCIO', name: 'DHS Office of the Chief Information Officer', page: false, days: 60 },
    { key: 487, label: 'DHS S&T', name: 'DHS Science and Technology Directorate', page: false, days: 60 },
    { key: 464, label: 'CBP', name: 'Customs and Border Protection', page: false, days: 60 },
    { key: 470, label: 'ICE', name: 'Immigration and Customs Enforcement', page: false, days: 60 },
    { key: 465, label: 'TSA', name: 'Transportation Security Administration', page: false, days: 60 },
    { key: 468, label: 'USCIS', name: 'Citizenship and Immigration Services', page: false, days: 60 },
    { key: 332, label: 'Air Force', name: 'Department of the Air Force', page: false, days: 60 },
    { key: 2799, label: 'AFLCMC San Antonio', name: 'AFLCMC Joint Base San Antonio (Cryptologic and Cyber Systems)', page: false, days: 60 },
    { key: 2791, label: 'AFLCMC Hanscom', name: 'AFLCMC Hanscom AFB', page: false, days: 60 },
    { key: 2084, label: 'AFRL', name: 'Air Force Research Laboratory', page: false, days: 60 },
    { key: 331, label: 'Army', name: 'Department of the Army', page: false, days: 60 },
    { key: 1013, label: 'ARCYBER', name: 'Army Cyber Command', aliases: ['ARCYBER', 'Army Cyber Command'], page: false, days: 60 },
    { key: 2732, label: 'ACC Orlando', name: 'Army Contracting Command Orlando (PEO STRI)', page: false, days: 60 },
    { key: 333, label: 'SOCOM', name: 'U.S. Special Operations Command', aliases: ['USSOCOM', 'SOCOM'], page: false, days: 60 },
    { key: 337, label: 'DARPA', name: 'Defense Advanced Research Projects Agency', page: false, days: 60 },
    { key: 335, label: 'DIA', name: 'Defense Intelligence Agency', aliases: ['Defense Intelligence Agency'], page: false, days: 60 },
    { key: 346, label: 'NSA', name: 'National Security Agency', aliases: ['National Security Agency'], page: false, days: 60 },
    { key: 362, label: 'NRO', name: 'National Reconnaissance Office', aliases: ['National Reconnaissance Office'], page: false, days: 60 },
    { key: 2847, label: 'CIA', name: 'Central Intelligence Agency', aliases: ['Central Intelligence Agency'], page: false, days: 60 },
    { key: 2165, label: 'GSA FEDSIM', name: 'GSA Assisted Acquisition Services FEDSIM', aliases: ['FEDSIM'], page: false, days: 60 },
  ],

  // HigherGov's API has no free-text search, so keyword coverage beyond the agencies above comes
  // from saved searches. Build a search on highergov.com (e.g. "cyber", "machine learning"), copy
  // the searchID from its URL, and list it here.
  //   { id: 'AbC123', label: 'Cyber keywords' }
  savedSearches: [],

  // Focus areas. Each notice is scored against every topic; anything that clears the threshold is
  // tagged with it. To add a topic, copy a block and change the terms.
  //   terms               [pattern(s), weight, label] - title hits count double
  //   psc / naics         Product-service and NAICS code prefixes that nudge the score
  //   usaspendingKeywords Search terms for the government-wide market view
  //   grantsKeywords      Search terms for Grants.gov
  topics: [
    {
      id: 'cyber',
      label: 'Cybersecurity',
      color: '#2563eb',
      terms: [
        [/cyber ?security|\bcyber\b|network defense/i, 3, 'cybersecurity'],
        [/zero[- ]trust/i, 3, 'zero trust'],
        [[/\bSOC\b/, /security operations? cent(er|re)/i], 3, 'SOC'],
        [/incident response|\bCSIRT\b|\bCIRT\b/i, 3, 'incident response'],
        [/threat (hunting|intelligence|detection|analysis)/i, 3, 'threat intel/hunting'],
        [/vulnerabilit(y|ies)|\bCVE\b|\bKEV\b/i, 2, 'vulnerability mgmt'],
        [/penetration test|pen[- ]?test|red team|blue team|purple team/i, 3, 'pentest/red team'],
        [[/continuous diagnostics/i, /\bCDM\b|EINSTEIN|\bCADS\b|\bJCDC\b|\bDEFEND\b/], 3, 'CDM/EINSTEIN/CADS'],
        [/malware|ransomware|intrusion (detection|prevention)|\bIDS\b|\bIPS\b/i, 2, 'malware/intrusion'],
        [/forensic/i, 2, 'forensics'],
        [/\bSIEM\b|\bSOAR\b|\bEDR\b|\bXDR\b|endpoint detection|security information and event/i, 3, 'SIEM/EDR'],
        [/\bICAM\b|identity,? credential|identity and access|\bPKI\b|multi[- ]factor/i, 2, 'identity/ICAM'],
        [/\bRMF\b|\bFISMA\b|\bATO\b|authority to operate|NIST (SP )?800|\bFedRAMP\b|\bCMMC\b/i, 2, 'RMF/ATO/compliance'],
        [/information (systems? )?security|\bINFOSEC\b|\bISSO\b|\bCISO\b|information assurance/i, 2, 'infosec/IA'],
        [/critical infrastructure|\bOT security\b|\bICS\b|SCADA/i, 2, 'critical infra/OT'],
        [/cryptograph|encryption|post[- ]quantum/i, 2, 'cryptography'],
      ],
      psc: [/^DJ/],
      naics: [],
      usaspendingKeywords: [
        'cybersecurity',
        'cyber security',
        'zero trust',
        'security operations center',
        'incident response',
        'threat hunting',
        'continuous diagnostics',
        'vulnerability management',
        'penetration testing',
        'threat intelligence',
      ],
      grantsKeywords: ['cybersecurity', 'cyber'],
    },
    {
      id: 'ai',
      label: 'AI & Data Science',
      color: '#7c3aed',
      terms: [
        [/data scien(ce|tist)/i, 3, 'data science'],
        [[/machine learning|mlops/i, /\bML\b/], 3, 'machine learning'],
        [[/artificial intelligence|generative|large language model/i, /\bAI\b|\bGenAI\b|\bLLMs?\b/], 3, 'AI / GenAI'],
        [/predictive (model|analytic)|forecasting model|statistical model/i, 3, 'predictive modeling'],
        [/natural language processing|\bNLP\b|computer vision|deep learning|neural network/i, 3, 'NLP/CV/DL'],
        [/data model(l)?ing|algorithm development|model development|model (training|validation)/i, 2, 'modeling'],
        [/\bautomation\b|robotic process automation|\bRPA\b/i, 1, 'automation/RPA'],
      ],
      psc: [/^AJ1/],
      naics: [/^541715/],
      usaspendingKeywords: [
        'data science',
        'machine learning',
        'artificial intelligence',
        'predictive analytics',
        'natural language processing',
        'computer vision',
        'generative ai',
      ],
      grantsKeywords: ['artificial intelligence', 'machine learning', 'data science'],
    },
    {
      id: 'analytics',
      label: 'Analytics & BI',
      color: '#0d9488',
      terms: [
        [/analytic/i, 3, 'analytics'],
        [/data analy(sis|st|ze)/i, 3, 'data analysis'],
        [[/business intelligence|power ?bi|tableau|qlik|looker/i, /\bBI\b/], 3, 'BI tools'],
        [/dashboard|visuali[sz]ation|reporting tool/i, 2, 'dashboards/viz'],
        [/statistic(al|s)|econometric|quantitative analysis|operations research/i, 2, 'statistics/OR'],
        [/risk analysis|risk assessment|performance measurement|metrics/i, 1, 'risk/performance analysis'],
      ],
      psc: [/^B5/, /^R4(08|10|99)/],
      naics: [/^5416(11|18)/, /^541690/],
      usaspendingKeywords: [
        'data analytics',
        'advanced analytics',
        'business intelligence',
        'data visualization',
        'analytics platform',
        'statistical analysis',
      ],
      grantsKeywords: ['data analytics', 'analytics'],
    },
    {
      id: 'data',
      label: 'Data Engineering & Platforms',
      color: '#b7791f',
      terms: [
        [/data (management|governance|strategy|architecture|engineering|integration|pipeline|catalog|sharing|fabric|mesh)/i, 3, 'data mgmt/engineering'],
        [/data ?(lake|warehouse|lakehouse|platform|hub)|big data/i, 3, 'data platforms'],
        [[/databricks|snowflake|palantir|splunk|hadoop|elasticsearch/i, /\bSpark\b|\bETL\b|\bELT\b/], 2, 'data tooling'],
        [/master data|metadata|data quality|data standards/i, 2, 'data quality/metadata'],
        [/cloud (migration|platform|services|hosting)|\bAWS\b|\bAzure\b|\bGCP\b/i, 1, 'cloud'],
      ],
      psc: [/^DH/, /^DK/, /^DB/],
      naics: [/^518210/],
      usaspendingKeywords: [
        'data management',
        'data platform',
        'data lake',
        'data warehouse',
        'data integration',
        'data engineering',
        'data governance',
      ],
      grantsKeywords: ['data infrastructure', 'data management'],
    },
  ],
};
