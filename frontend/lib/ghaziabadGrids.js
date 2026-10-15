// Real Ghaziabad junctions for the 5×5 and 9×9 grids, extracted from OpenStreetMap
// (© OpenStreetMap contributors, ODbL) — signalised junctions (highway=traffic_signals)
// and intersections of named trunk/primary/secondary/tertiary roads. Entries with an
// `anchor` reuse the surveyed junction of that id from the 3×3 core grid.
export const GHAZIABAD_GRID_JUNCTIONS = {
  "5": [
    {
      "id": "GZB-5-R1C1",
      "name": "80 Feet Road × Wazirabad Road",
      "corridor": "80 Feet Road / Wazirabad Road",
      "lat": 28.69446,
      "lon": 77.34032,
      "signalized": false,
      "gridRow": 0,
      "gridCol": 0
    },
    {
      "id": "GZB-5-R1C2",
      "name": "Ashram Road × Ghaziabad Bypass",
      "corridor": "Ashram Road / Ghaziabad Bypass",
      "lat": 28.69234,
      "lon": 77.40009,
      "signalized": false,
      "gridRow": 0,
      "gridCol": 1
    },
    {
      "anchor": "GZB-J2",
      "gridRow": 0,
      "gridCol": 2
    },
    {
      "anchor": "GZB-J9",
      "gridRow": 0,
      "gridCol": 3
    },
    {
      "id": "GZB-5-R1C5",
      "name": "Meerut Road × Raj Nagar Extension Road Flyover",
      "corridor": "Meerut Road / Raj Nagar Extension Road Flyover",
      "lat": 28.69804,
      "lon": 77.44455,
      "signalized": false,
      "gridRow": 0,
      "gridCol": 4
    },
    {
      "id": "GZB-5-R2C1",
      "name": "Gurudwara Road × New Seemapuri Road",
      "corridor": "Gurudwara Road / New Seemapuri Road",
      "lat": 28.684,
      "lon": 77.32645,
      "signalized": false,
      "gridRow": 1,
      "gridCol": 0
    },
    {
      "id": "GZB-5-R2C2",
      "name": "Dr. Rajendra Prasad Marg × Dr. Zakir Hussain Marg",
      "corridor": "Dr. Rajendra Prasad Marg / Dr. Zakir Hussain Marg",
      "lat": 28.6845,
      "lon": 77.35833,
      "signalized": false,
      "gridRow": 1,
      "gridCol": 1
    },
    {
      "anchor": "GZB-J1",
      "gridRow": 1,
      "gridCol": 2
    },
    {
      "id": "GZB-5-R2C4",
      "name": "Rani Jhansi Road × Shivaji Marg",
      "corridor": "Rani Jhansi Road / Shivaji Marg",
      "lat": 28.68356,
      "lon": 77.45329,
      "signalized": false,
      "gridRow": 1,
      "gridCol": 3
    },
    {
      "anchor": "GZB-J8",
      "gridRow": 1,
      "gridCol": 4
    },
    {
      "anchor": "GZB-J6",
      "gridRow": 2,
      "gridCol": 0
    },
    {
      "id": "GZB-5-R3C2",
      "name": "Grand Trunk Road × Meerut Road",
      "corridor": "Grand Trunk Road / Meerut Road",
      "lat": 28.67345,
      "lon": 77.41493,
      "signalized": false,
      "gridRow": 2,
      "gridCol": 1
    },
    {
      "anchor": "GZB-J3",
      "gridRow": 2,
      "gridCol": 2
    },
    {
      "id": "GZB-5-R3C4",
      "name": "Maharaja Surajmal Marg × Nirala Marg",
      "corridor": "Maharaja Surajmal Marg / Nirala Marg",
      "lat": 28.67156,
      "lon": 77.46663,
      "signalized": false,
      "gridRow": 2,
      "gridCol": 3
    },
    {
      "id": "GZB-5-R3C5",
      "name": "NH9 × Flyover",
      "corridor": "NH9 / Flyover",
      "lat": 28.65604,
      "lon": 77.47385,
      "signalized": false,
      "gridRow": 2,
      "gridCol": 4
    },
    {
      "id": "GZB-5-R4C1",
      "name": "Madan Mohan Malviya Marg × Harshvardhan Marg",
      "corridor": "Madan Mohan Malviya Marg / Harshvardhan Marg",
      "lat": 28.65181,
      "lon": 77.3416,
      "signalized": true,
      "gridRow": 3,
      "gridCol": 0
    },
    {
      "anchor": "GZB-J7",
      "gridRow": 3,
      "gridCol": 1
    },
    {
      "id": "GZB-5-R4C3",
      "name": "Gaushala Road × Pratap Vihar Road",
      "corridor": "Gaushala Road / Pratap Vihar Road",
      "lat": 28.65221,
      "lon": 77.41107,
      "signalized": false,
      "gridRow": 3,
      "gridCol": 2
    },
    {
      "id": "GZB-5-R4C4",
      "name": "Grand Trunk Road × Rakesh Marg",
      "corridor": "Grand Trunk Road / Rakesh Marg",
      "lat": 28.65033,
      "lon": 77.44136,
      "signalized": true,
      "gridRow": 3,
      "gridCol": 3
    },
    {
      "id": "GZB-5-R4C5",
      "name": "NH34 × Flyover",
      "corridor": "NH34 / Flyover",
      "lat": 28.64367,
      "lon": 77.46551,
      "signalized": false,
      "gridRow": 3,
      "gridCol": 4
    },
    {
      "anchor": "GZB-J4",
      "gridRow": 4,
      "gridCol": 0
    },
    {
      "id": "GZB-5-R5C2",
      "name": "FSSF Road × ser saloni park",
      "corridor": "FSSF Road / ser saloni park",
      "lat": 28.63355,
      "lon": 77.34971,
      "signalized": false,
      "gridRow": 4,
      "gridCol": 1
    },
    {
      "id": "GZB-5-R5C3",
      "name": "Paramahansa Yogananda Road × Sushil Marg",
      "corridor": "Paramahansa Yogananda Road / Sushil Marg",
      "lat": 28.62396,
      "lon": 77.36474,
      "signalized": false,
      "gridRow": 4,
      "gridCol": 2
    },
    {
      "id": "GZB-5-R5C4",
      "name": "Faridabad-Noida-Ghaziabad Expressway × Pusta Road",
      "corridor": "Faridabad-Noida-Ghaziabad Expressway / Pusta Road",
      "lat": 28.62745,
      "lon": 77.39377,
      "signalized": false,
      "gridRow": 4,
      "gridCol": 3
    },
    {
      "anchor": "GZB-J5",
      "gridRow": 4,
      "gridCol": 4
    }
  ],
  "9": [
    {
      "id": "GZB-9-R1C1",
      "name": "80 Feet Road × Wazirabad Road",
      "corridor": "80 Feet Road / Wazirabad Road",
      "lat": 28.69446,
      "lon": 77.34032,
      "signalized": false,
      "gridRow": 0,
      "gridCol": 0
    },
    {
      "id": "GZB-9-R1C2",
      "name": "Dr. Radha Krishnan Marg × Wazirabad Road",
      "corridor": "Dr. Radha Krishnan Marg / Wazirabad Road",
      "lat": 28.68846,
      "lon": 77.37041,
      "signalized": false,
      "gridRow": 0,
      "gridCol": 1
    },
    {
      "id": "GZB-9-R1C3",
      "name": "Ashram Road × Ghaziabad Bypass",
      "corridor": "Ashram Road / Ghaziabad Bypass",
      "lat": 28.69234,
      "lon": 77.40009,
      "signalized": false,
      "gridRow": 0,
      "gridCol": 2
    },
    {
      "id": "GZB-9-R1C4",
      "name": "Ghaziabad Bypass × Prakash Vir Shastri Road",
      "corridor": "Ghaziabad Bypass / Prakash Vir Shastri Road",
      "lat": 28.70285,
      "lon": 77.41796,
      "signalized": true,
      "gridRow": 0,
      "gridCol": 3
    },
    {
      "anchor": "GZB-J2",
      "gridRow": 0,
      "gridCol": 4
    },
    {
      "anchor": "GZB-J9",
      "gridRow": 0,
      "gridCol": 5
    },
    {
      "id": "GZB-9-R1C7",
      "name": "Maharana Pratap Marg × Prithviraj Marg",
      "corridor": "Maharana Pratap Marg / Prithviraj Marg",
      "lat": 28.68797,
      "lon": 77.44174,
      "signalized": false,
      "gridRow": 0,
      "gridCol": 6
    },
    {
      "id": "GZB-9-R1C8",
      "name": "Meerut Road × Raj Nagar Extension Road Flyover",
      "corridor": "Meerut Road / Raj Nagar Extension Road Flyover",
      "lat": 28.69804,
      "lon": 77.44455,
      "signalized": false,
      "gridRow": 0,
      "gridCol": 7
    },
    {
      "id": "GZB-9-R1C9",
      "name": "Maharana Pratap Marg × Rani Jhansi Road",
      "corridor": "Maharana Pratap Marg / Rani Jhansi Road",
      "lat": 28.69059,
      "lon": 77.44798,
      "signalized": false,
      "gridRow": 0,
      "gridCol": 8
    },
    {
      "id": "GZB-9-R2C1",
      "name": "New Seemapuri Road × Pocket Park Road",
      "corridor": "New Seemapuri Road / Pocket Park Road",
      "lat": 28.68682,
      "lon": 77.3245,
      "signalized": false,
      "gridRow": 1,
      "gridCol": 0
    },
    {
      "id": "GZB-9-R2C2",
      "name": "Aradhak Marg × Gurudwara Road",
      "corridor": "Aradhak Marg / Gurudwara Road",
      "lat": 28.68639,
      "lon": 77.33093,
      "signalized": false,
      "gridRow": 1,
      "gridCol": 1
    },
    {
      "id": "GZB-9-R2C3",
      "name": "150 feet road × Dr. Zakir Hussain Marg",
      "corridor": "150 feet road / Dr. Zakir Hussain Marg",
      "lat": 28.68727,
      "lon": 77.34121,
      "signalized": false,
      "gridRow": 1,
      "gridCol": 2
    },
    {
      "id": "GZB-9-R2C4",
      "name": "Dr. Zakir Hussain Marg × Vinod Marg",
      "corridor": "Dr. Zakir Hussain Marg / Vinod Marg",
      "lat": 28.68393,
      "lon": 77.35276,
      "signalized": false,
      "gridRow": 1,
      "gridCol": 3
    },
    {
      "id": "GZB-9-R2C5",
      "name": "Ghaziabad Bypass × NH9",
      "corridor": "Ghaziabad Bypass / NH9",
      "lat": 28.68733,
      "lon": 77.3989,
      "signalized": false,
      "gridRow": 1,
      "gridCol": 4
    },
    {
      "id": "GZB-9-R2C6",
      "name": "Ashram Road × Nandagram Road",
      "corridor": "Ashram Road / Nandagram Road",
      "lat": 28.685,
      "lon": 77.41306,
      "signalized": false,
      "gridRow": 1,
      "gridCol": 5
    },
    {
      "id": "GZB-9-R2C7",
      "name": "Ashok Marg × Shivaji Marg",
      "corridor": "Ashok Marg / Shivaji Marg",
      "lat": 28.6817,
      "lon": 77.4414,
      "signalized": false,
      "gridRow": 1,
      "gridCol": 6
    },
    {
      "id": "GZB-9-R2C8",
      "name": "Rani Jhansi Road × Shivaji Marg",
      "corridor": "Rani Jhansi Road / Shivaji Marg",
      "lat": 28.68356,
      "lon": 77.45329,
      "signalized": false,
      "gridRow": 1,
      "gridCol": 7
    },
    {
      "id": "GZB-9-R2C9",
      "name": "Main Govindpuram Road × Road No 3",
      "corridor": "Main Govindpuram Road / Road No 3",
      "lat": 28.68394,
      "lon": 77.49204,
      "signalized": false,
      "gridRow": 1,
      "gridCol": 8
    },
    {
      "id": "GZB-9-R3C1",
      "name": "Pocket Dishad Garden Road × Pocket-I Road",
      "corridor": "Pocket Dishad Garden Road / Pocket-I Road",
      "lat": 28.68069,
      "lon": 77.32019,
      "signalized": false,
      "gridRow": 2,
      "gridCol": 0
    },
    {
      "id": "GZB-9-R3C2",
      "name": "GT Road × hakikat marg",
      "corridor": "GT Road / hakikat marg",
      "lat": 28.6771,
      "lon": 77.34559,
      "signalized": false,
      "gridRow": 2,
      "gridCol": 1
    },
    {
      "id": "GZB-9-R3C3",
      "name": "GT Road × Vinod Marg",
      "corridor": "GT Road / Vinod Marg",
      "lat": 28.67737,
      "lon": 77.35139,
      "signalized": false,
      "gridRow": 2,
      "gridCol": 2
    },
    {
      "id": "GZB-9-R3C4",
      "name": "GT Road × Shalimar Chowk",
      "corridor": "GT Road / Shalimar Chowk",
      "lat": 28.67778,
      "lon": 77.35996,
      "signalized": false,
      "gridRow": 2,
      "gridCol": 3
    },
    {
      "id": "GZB-9-R3C5",
      "name": "GT Road × Kali Mandir Marg",
      "corridor": "GT Road / Kali Mandir Marg",
      "lat": 28.67839,
      "lon": 77.37195,
      "signalized": false,
      "gridRow": 2,
      "gridCol": 4
    },
    {
      "id": "GZB-9-R3C6",
      "name": "GT Road × Madan Mohan Malviya Marg",
      "corridor": "GT Road / Madan Mohan Malviya Marg",
      "lat": 28.67852,
      "lon": 77.38237,
      "signalized": false,
      "gridRow": 2,
      "gridCol": 5
    },
    {
      "anchor": "GZB-J1",
      "gridRow": 2,
      "gridCol": 6
    },
    {
      "anchor": "GZB-J8",
      "gridRow": 2,
      "gridCol": 7
    },
    {
      "id": "GZB-9-R3C9",
      "name": "Hapur Road × Dasna Railway Flyover",
      "corridor": "Hapur Road / Dasna Railway Flyover",
      "lat": 28.68149,
      "lon": 77.50044,
      "signalized": false,
      "gridRow": 2,
      "gridCol": 8
    },
    {
      "id": "GZB-9-R4C1",
      "name": "GT Road × Railway Road",
      "corridor": "GT Road / Railway Road",
      "lat": 28.67613,
      "lon": 77.31624,
      "signalized": true,
      "gridRow": 3,
      "gridCol": 0
    },
    {
      "id": "GZB-9-R4C2",
      "name": "Ghazipur Road × Vivek Vihar Railway Flyover",
      "corridor": "Ghazipur Road / Vivek Vihar Railway Flyover",
      "lat": 28.67054,
      "lon": 77.32278,
      "signalized": false,
      "gridRow": 3,
      "gridCol": 1
    },
    {
      "id": "GZB-9-R4C3",
      "name": "Railway Road × Underpass road",
      "corridor": "Railway Road / Underpass road",
      "lat": 28.67492,
      "lon": 77.36418,
      "signalized": false,
      "gridRow": 3,
      "gridCol": 2
    },
    {
      "id": "GZB-9-R4C4",
      "name": "Madan Mohan Malviya Marg × Mohan Nagar Railway Crossing Flyover",
      "corridor": "Madan Mohan Malviya Marg / Mohan Nagar Railway Crossing Flyover",
      "lat": 28.67006,
      "lon": 77.37387,
      "signalized": false,
      "gridRow": 3,
      "gridCol": 3
    },
    {
      "id": "GZB-9-R4C5",
      "name": "Ghaziabad Bypass × Wazirabad Road",
      "corridor": "Ghaziabad Bypass / Wazirabad Road",
      "lat": 28.67348,
      "lon": 77.40537,
      "signalized": false,
      "gridRow": 3,
      "gridCol": 4
    },
    {
      "id": "GZB-9-R4C6",
      "name": "Grand Trunk Road × Meerut Road",
      "corridor": "Grand Trunk Road / Meerut Road",
      "lat": 28.67345,
      "lon": 77.41493,
      "signalized": false,
      "gridRow": 3,
      "gridCol": 5
    },
    {
      "id": "GZB-9-R4C7",
      "name": "Ashok Marg × Hapur Road",
      "corridor": "Ashok Marg / Hapur Road",
      "lat": 28.67231,
      "lon": 77.44321,
      "signalized": false,
      "gridRow": 3,
      "gridCol": 6
    },
    {
      "id": "GZB-9-R4C8",
      "name": "Hapur Road × Rani Jhansi Road",
      "corridor": "Hapur Road / Rani Jhansi Road",
      "lat": 28.67417,
      "lon": 77.45538,
      "signalized": true,
      "gridRow": 3,
      "gridCol": 7
    },
    {
      "id": "GZB-9-R4C9",
      "name": "Maharaja Surajmal Marg × Nirala Marg",
      "corridor": "Maharaja Surajmal Marg / Nirala Marg",
      "lat": 28.67156,
      "lon": 77.46663,
      "signalized": false,
      "gridRow": 3,
      "gridCol": 8
    },
    {
      "id": "GZB-9-R5C1",
      "name": "Road No 71A × Vivek Vihar Road",
      "corridor": "Road No 71A / Vivek Vihar Road",
      "lat": 28.66529,
      "lon": 77.3152,
      "signalized": false,
      "gridRow": 4,
      "gridCol": 0
    },
    {
      "id": "GZB-9-R5C2",
      "name": "Road No 71A × Doctor Bhaba Marg",
      "corridor": "Road No 71A / Doctor Bhaba Marg",
      "lat": 28.66417,
      "lon": 77.32069,
      "signalized": true,
      "gridRow": 4,
      "gridCol": 1
    },
    {
      "id": "GZB-9-R5C3",
      "name": "Dr BR Ambedkar Road × Madan Mohan Malviya Marg",
      "corridor": "Dr BR Ambedkar Road / Madan Mohan Malviya Marg",
      "lat": 28.6613,
      "lon": 77.35754,
      "signalized": false,
      "gridRow": 4,
      "gridCol": 2
    },
    {
      "anchor": "GZB-J6",
      "gridRow": 4,
      "gridCol": 3
    },
    {
      "id": "GZB-9-R5C5",
      "name": "Grand Trunk Road × Delhi Gate Flyover",
      "corridor": "Grand Trunk Road / Delhi Gate Flyover",
      "lat": 28.66141,
      "lon": 77.42579,
      "signalized": false,
      "gridRow": 4,
      "gridCol": 4
    },
    {
      "id": "GZB-9-R5C6",
      "name": "hapur road × patel nagar road",
      "corridor": "hapur road / patel nagar road",
      "lat": 28.67004,
      "lon": 77.42869,
      "signalized": false,
      "gridRow": 4,
      "gridCol": 5
    },
    {
      "id": "GZB-9-R5C7",
      "name": "Dasna Marg × Ambedkar Road",
      "corridor": "Dasna Marg / Ambedkar Road",
      "lat": 28.66714,
      "lon": 77.43297,
      "signalized": true,
      "gridRow": 4,
      "gridCol": 6
    },
    {
      "anchor": "GZB-J3",
      "gridRow": 4,
      "gridCol": 7
    },
    {
      "id": "GZB-9-R5C9",
      "name": "NH9 / NH34 × Surdas Marg",
      "corridor": "NH9 / NH34 / Surdas Marg",
      "lat": 28.66516,
      "lon": 77.45598,
      "signalized": true,
      "gridRow": 4,
      "gridCol": 8
    },
    {
      "id": "GZB-9-R6C1",
      "name": "Ghazipur Road × Anand Vihar Railway Terminal Flyover",
      "corridor": "Ghazipur Road / Anand Vihar Railway Terminal Flyover",
      "lat": 28.65854,
      "lon": 77.32001,
      "signalized": false,
      "gridRow": 5,
      "gridCol": 0
    },
    {
      "id": "GZB-9-R6C2",
      "name": "Madan Mohan Malviya Marg Junction",
      "corridor": "Madan Mohan Malviya Marg",
      "lat": 28.65721,
      "lon": 77.35041,
      "signalized": true,
      "gridRow": 5,
      "gridCol": 1
    },
    {
      "id": "GZB-9-R6C3",
      "name": "Atal Chowk × Dr BR Ambedkar Road",
      "corridor": "Atal Chowk / Dr BR Ambedkar Road",
      "lat": 28.65631,
      "lon": 77.36083,
      "signalized": false,
      "gridRow": 5,
      "gridCol": 2
    },
    {
      "id": "GZB-9-R6C4",
      "name": "Kaveri Marg × Mohan Nagar Link Road",
      "corridor": "Kaveri Marg / Mohan Nagar Link Road",
      "lat": 28.65519,
      "lon": 77.37666,
      "signalized": false,
      "gridRow": 5,
      "gridCol": 3
    },
    {
      "id": "GZB-9-R6C5",
      "name": "Gaushala Road × Pratap Vihar Road",
      "corridor": "Gaushala Road / Pratap Vihar Road",
      "lat": 28.65221,
      "lon": 77.41107,
      "signalized": false,
      "gridRow": 5,
      "gridCol": 4
    },
    {
      "id": "GZB-9-R6C6",
      "name": "Grand Trunk Road Junction",
      "corridor": "Grand Trunk Road",
      "lat": 28.65577,
      "lon": 77.43377,
      "signalized": true,
      "gridRow": 5,
      "gridCol": 5
    },
    {
      "id": "GZB-9-R6C7",
      "name": "Maharana Pratap Marg × Surdas Marg",
      "corridor": "Maharana Pratap Marg / Surdas Marg",
      "lat": 28.65612,
      "lon": 77.4517,
      "signalized": false,
      "gridRow": 5,
      "gridCol": 6
    },
    {
      "id": "GZB-9-R6C8",
      "name": "NH9 / NH34 × Diamond Flyover",
      "corridor": "NH9 / NH34 / Diamond Flyover",
      "lat": 28.65866,
      "lon": 77.46775,
      "signalized": false,
      "gridRow": 5,
      "gridCol": 7
    },
    {
      "id": "GZB-9-R6C9",
      "name": "NH9 × Flyover",
      "corridor": "NH9 / Flyover",
      "lat": 28.65604,
      "lon": 77.47385,
      "signalized": false,
      "gridRow": 5,
      "gridCol": 8
    },
    {
      "id": "GZB-9-R7C1",
      "name": "Ghazipur Road Junction",
      "corridor": "Ghazipur Road",
      "lat": 28.64546,
      "lon": 77.31714,
      "signalized": true,
      "gridRow": 6,
      "gridCol": 0
    },
    {
      "id": "GZB-9-R7C2",
      "name": "Madan Mohan Malviya Marg × Baman Marg",
      "corridor": "Madan Mohan Malviya Marg / Baman Marg",
      "lat": 28.64596,
      "lon": 77.33138,
      "signalized": true,
      "gridRow": 6,
      "gridCol": 1
    },
    {
      "id": "GZB-9-R7C3",
      "name": "Dharam Marg × Yashoda Marg",
      "corridor": "Dharam Marg / Yashoda Marg",
      "lat": 28.64474,
      "lon": 77.33821,
      "signalized": false,
      "gridRow": 6,
      "gridCol": 2
    },
    {
      "id": "GZB-9-R7C4",
      "name": "Madan Mohan Malviya Marg × Harshvardhan Marg",
      "corridor": "Madan Mohan Malviya Marg / Harshvardhan Marg",
      "lat": 28.65181,
      "lon": 77.3416,
      "signalized": true,
      "gridRow": 6,
      "gridCol": 3
    },
    {
      "id": "GZB-9-R7C5",
      "name": "Grudwara Road × Harshvardhan Marg",
      "corridor": "Grudwara Road / Harshvardhan Marg",
      "lat": 28.64592,
      "lon": 77.34951,
      "signalized": false,
      "gridRow": 6,
      "gridCol": 4
    },
    {
      "id": "GZB-9-R7C6",
      "name": "Kala Pathar Road × Kaveri Marg",
      "corridor": "Kala Pathar Road / Kaveri Marg",
      "lat": 28.64841,
      "lon": 77.35971,
      "signalized": false,
      "gridRow": 6,
      "gridCol": 5
    },
    {
      "anchor": "GZB-J7",
      "gridRow": 6,
      "gridCol": 6
    },
    {
      "id": "GZB-9-R7C8",
      "name": "Gaushala Road × Thana Road",
      "corridor": "Gaushala Road / Thana Road",
      "lat": 28.65141,
      "lon": 77.42031,
      "signalized": false,
      "gridRow": 6,
      "gridCol": 7
    },
    {
      "id": "GZB-9-R7C9",
      "name": "Grand Trunk Road × Rakesh Marg",
      "corridor": "Grand Trunk Road / Rakesh Marg",
      "lat": 28.65033,
      "lon": 77.44136,
      "signalized": true,
      "gridRow": 6,
      "gridCol": 8
    },
    {
      "anchor": "GZB-J4",
      "gridRow": 7,
      "gridCol": 0
    },
    {
      "id": "GZB-9-R8C2",
      "name": "DME Service Road × National Highway 24 Bypass",
      "corridor": "DME Service Road / National Highway 24 Bypass",
      "lat": 28.63265,
      "lon": 77.344,
      "signalized": false,
      "gridRow": 7,
      "gridCol": 1
    },
    {
      "id": "GZB-9-R8C3",
      "name": "Kala Pathar Road × Mall Road",
      "corridor": "Kala Pathar Road / Mall Road",
      "lat": 28.64115,
      "lon": 77.35989,
      "signalized": false,
      "gridRow": 7,
      "gridCol": 2
    },
    {
      "id": "GZB-9-R8C4",
      "name": "Mall Road × Mohan Nagar Link Road",
      "corridor": "Mall Road / Mohan Nagar Link Road",
      "lat": 28.64163,
      "lon": 77.37865,
      "signalized": false,
      "gridRow": 7,
      "gridCol": 3
    },
    {
      "id": "GZB-9-R8C5",
      "name": "National Highway 24 Bypass × Pusta Road",
      "corridor": "National Highway 24 Bypass / Pusta Road",
      "lat": 28.63457,
      "lon": 77.39074,
      "signalized": false,
      "gridRow": 7,
      "gridCol": 4
    },
    {
      "id": "GZB-9-R8C6",
      "name": "DME Service Road × Flyover",
      "corridor": "DME Service Road / Flyover",
      "lat": 28.64087,
      "lon": 77.42005,
      "signalized": false,
      "gridRow": 7,
      "gridCol": 5
    },
    {
      "anchor": "GZB-J5",
      "gridRow": 7,
      "gridCol": 6
    },
    {
      "id": "GZB-9-R8C8",
      "name": "Grand Trunk Road × Ghaziabad Railway Flyover",
      "corridor": "Grand Trunk Road / Ghaziabad Railway Flyover",
      "lat": 28.644,
      "lon": 77.45017,
      "signalized": false,
      "gridRow": 7,
      "gridCol": 7
    },
    {
      "id": "GZB-9-R8C9",
      "name": "NH34 × Flyover",
      "corridor": "NH34 / Flyover",
      "lat": 28.64367,
      "lon": 77.46551,
      "signalized": false,
      "gridRow": 7,
      "gridCol": 8
    },
    {
      "id": "GZB-9-R9C1",
      "name": "Ghazipur Road × Khichripur Road",
      "corridor": "Ghazipur Road / Khichripur Road",
      "lat": 28.615,
      "lon": 77.32024,
      "signalized": false,
      "gridRow": 8,
      "gridCol": 0
    },
    {
      "id": "GZB-9-R9C2",
      "name": "Khora Road × Shivaji Marg",
      "corridor": "Khora Road / Shivaji Marg",
      "lat": 28.62191,
      "lon": 77.34015,
      "signalized": false,
      "gridRow": 8,
      "gridCol": 1
    },
    {
      "id": "GZB-9-R9C3",
      "name": "Pragati Marg × Road Number 109",
      "corridor": "Pragati Marg / Road Number 109",
      "lat": 28.61565,
      "lon": 77.34141,
      "signalized": false,
      "gridRow": 8,
      "gridCol": 2
    },
    {
      "id": "GZB-9-R9C4",
      "name": "DME Service Road × FSSF Road",
      "corridor": "DME Service Road / FSSF Road",
      "lat": 28.63261,
      "lon": 77.35571,
      "signalized": false,
      "gridRow": 8,
      "gridCol": 3
    },
    {
      "id": "GZB-9-R9C5",
      "name": "Paramahansa Yogananda Road × Sushil Marg",
      "corridor": "Paramahansa Yogananda Road / Sushil Marg",
      "lat": 28.62396,
      "lon": 77.36474,
      "signalized": false,
      "gridRow": 8,
      "gridCol": 4
    },
    {
      "id": "GZB-9-R9C6",
      "name": "B Block Road × Vishwakarma Road",
      "corridor": "B Block Road / Vishwakarma Road",
      "lat": 28.61525,
      "lon": 77.37351,
      "signalized": false,
      "gridRow": 8,
      "gridCol": 5
    },
    {
      "id": "GZB-9-R9C7",
      "name": "Vishwakarma Road Junction",
      "corridor": "Vishwakarma Road",
      "lat": 28.6239,
      "lon": 77.37426,
      "signalized": true,
      "gridRow": 8,
      "gridCol": 6
    },
    {
      "id": "GZB-9-R9C8",
      "name": "NH 9 × NH9",
      "corridor": "NH 9 / NH9",
      "lat": 28.63237,
      "lon": 77.37431,
      "signalized": false,
      "gridRow": 8,
      "gridCol": 7
    },
    {
      "id": "GZB-9-R9C9",
      "name": "Faridabad-Noida-Ghaziabad Expressway × Pusta Road",
      "corridor": "Faridabad-Noida-Ghaziabad Expressway / Pusta Road",
      "lat": 28.62745,
      "lon": 77.39377,
      "signalized": false,
      "gridRow": 8,
      "gridCol": 8
    }
  ]
};
