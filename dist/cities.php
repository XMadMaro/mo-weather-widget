<?php
declare(strict_types=1);

/**
 * MO Weather Widget — Konfiguracja 14 miast aglomeracji górnośląsko-zagłębiowskiej
 * Wersja: 2.0.0
 * 
 * ŹRÓDŁO PRAWDY (Single Source of Truth) dla współrzędnych, kodów TERYT oraz stacji GIOŚ.
 * 
 * Reguły pomiarowe i ograniczenia API:
 *  - Katowice (17318) to JEDYNA stacja w sieci z bieżącym automatycznym pomiarem PM2,5 (28759).
 *  - Gliwice (809): PM10 automatyczny (5312). Stanowisko PM2,5 (5314) jest manualne (brak danych online).
 *  - Dąbrowa Górnicza (805): PM10 (5286). Stanowisko 5287 jest manualne — pominięte.
 *  - Zabrze (17880): PM10 (29671). Stanowisko 29679 jest manualne — pominięte.
 *  - Sosnowiec (837) i Tychy (841): wyłącznie PM10.
 *  - Tarnowskie Góry (839) i Knurów (818): stacje istnieją w rejestrze, ale nie raportują danych bieżących.
 *  - Miasta bez stacji lub z nieaktywnymi stacjami (8 miast): prognoza 3-dniowa IOŚ-PIB per TERYT.
 *  - Knurów (2405) i Będzin (2401) to TERYT na poziomie powiatu -> etykieta "dla powiatu", nie "dla miasta".
 */

return [
    'katowice' => [
        'slug'            => 'katowice',
        'label'           => 'Katowice',
        'lat'             => 50.2649,
        'lon'             => 19.0238,
        'teryt'           => '2469',
        'teryt_level'     => 'city',
        'teryt_name'      => 'Katowice',
        'has_gios'        => true,
        'gios_station_id' => 17318,
        'station_name'    => 'Katowice, ul. Dudy-Gracza',
        'sensors'         => [
            'pm10' => 28758,
            'pm25' => 28759,
        ],
        'ignored_sensors' => [],
        'last_verified'   => '2026-10-07',
    ],
    'gliwice' => [
        'slug'            => 'gliwice',
        'label'           => 'Gliwice',
        'lat'             => 50.2945,
        'lon'             => 18.6714,
        'teryt'           => '2466',
        'teryt_level'     => 'city',
        'teryt_name'      => 'Gliwice',
        'has_gios'        => true,
        'gios_station_id' => 809,
        'station_name'    => 'Gliwice, ul. Mewy',
        'sensors'         => [
            'pm10' => 5312,
            'pm25' => null,
        ],
        'ignored_sensors' => [5314], // manualne PM2,5
        'last_verified'   => '2026-10-07',
    ],
    'sosnowiec' => [
        'slug'            => 'sosnowiec',
        'label'           => 'Sosnowiec',
        'lat'             => 50.2862,
        'lon'             => 19.1041,
        'teryt'           => '2475',
        'teryt_level'     => 'city',
        'teryt_name'      => 'Sosnowiec',
        'has_gios'        => true,
        'gios_station_id' => 837,
        'station_name'    => 'Sosnowiec, ul. Lubelska',
        'sensors'         => [
            'pm10' => 5480,
            'pm25' => null,
        ],
        'ignored_sensors' => [],
        'last_verified'   => '2026-10-07',
    ],
    'zabrze' => [
        'slug'            => 'zabrze',
        'label'           => 'Zabrze',
        'lat'             => 50.3249,
        'lon'             => 18.7856,
        'teryt'           => '2478',
        'teryt_level'     => 'city',
        'teryt_name'      => 'Zabrze',
        'has_gios'        => true,
        'gios_station_id' => 17880,
        'station_name'    => 'Zabrze, ul. Curie-Skłodowskiej',
        'sensors'         => [
            'pm10' => 29671,
            'pm25' => null,
        ],
        'ignored_sensors' => [29679], // manualne PM10
        'last_verified'   => '2026-10-07',
    ],
    'tychy' => [
        'slug'            => 'tychy',
        'label'           => 'Tychy',
        'lat'             => 50.1234,
        'lon'             => 18.9868,
        'teryt'           => '2477',
        'teryt_level'     => 'city',
        'teryt_name'      => 'Tychy',
        'has_gios'        => true,
        'gios_station_id' => 841,
        'station_name'    => 'Tychy, ul. Tołstoja',
        'sensors'         => [
            'pm10' => 5505,
            'pm25' => null,
        ],
        'ignored_sensors' => [],
        'last_verified'   => '2026-10-07',
    ],
    'dabrowa-gornicza' => [
        'slug'            => 'dabrowa-gornicza',
        'label'           => 'Dąbrowa Górnicza',
        'lat'             => 50.3204,
        'lon'             => 19.1942,
        'teryt'           => '2465',
        'teryt_level'     => 'city',
        'teryt_name'      => 'Dąbrowa Górnicza',
        'has_gios'        => true,
        'gios_station_id' => 805,
        'station_name'    => 'Dąbrowa Górnicza, ul. Tysiąclecia',
        'sensors'         => [
            'pm10' => 5286,
            'pm25' => null,
        ],
        'ignored_sensors' => [5287], // manualne PM10
        'last_verified'   => '2026-10-07',
    ],
    'bytom' => [
        'slug'            => 'bytom',
        'label'           => 'Bytom',
        'lat'             => 50.3484,
        'lon'             => 18.9158,
        'teryt'           => '2462',
        'teryt_level'     => 'city',
        'teryt_name'      => 'Bytom',
        'has_gios'        => false,
        'gios_station_id' => null,
        'station_name'    => null,
        'sensors'         => [
            'pm10' => null,
            'pm25' => null,
        ],
        'ignored_sensors' => [],
        'last_verified'   => '2026-10-07',
    ],
    'chorzow' => [
        'slug'            => 'chorzow',
        'label'           => 'Chorzów',
        'lat'             => 50.2974,
        'lon'             => 18.9546,
        'teryt'           => '2463',
        'teryt_level'     => 'city',
        'teryt_name'      => 'Chorzów',
        'has_gios'        => false,
        'gios_station_id' => null,
        'station_name'    => null,
        'sensors'         => [
            'pm10' => null,
            'pm25' => null,
        ],
        'ignored_sensors' => [],
        'last_verified'   => '2026-10-07',
    ],
    'swietochlowice' => [
        'slug'            => 'swietochlowice',
        'label'           => 'Świętochłowice',
        'lat'             => 50.2925,
        'lon'             => 18.9189,
        'teryt'           => '2476',
        'teryt_level'     => 'city',
        'teryt_name'      => 'Świętochłowice',
        'has_gios'        => false,
        'gios_station_id' => null,
        'station_name'    => null,
        'sensors'         => [
            'pm10' => null,
            'pm25' => null,
        ],
        'ignored_sensors' => [],
        'last_verified'   => '2026-10-07',
    ],
    'ruda-slaska' => [
        'slug'            => 'ruda-slaska',
        'label'           => 'Ruda Śląska',
        'lat'             => 50.2586,
        'lon'             => 18.8576,
        'teryt'           => '2472',
        'teryt_level'     => 'city',
        'teryt_name'      => 'Ruda Śląska',
        'has_gios'        => false,
        'gios_station_id' => null,
        'station_name'    => null,
        'sensors'         => [
            'pm10' => null,
            'pm25' => null,
        ],
        'ignored_sensors' => [],
        'last_verified'   => '2026-10-07',
    ],
    'piekary-slaskie' => [
        'slug'            => 'piekary-slaskie',
        'label'           => 'Piekary Śląskie',
        'lat'             => 50.3708,
        'lon'             => 18.9446,
        'teryt'           => '2471',
        'teryt_level'     => 'city',
        'teryt_name'      => 'Piekary Śląskie',
        'has_gios'        => false,
        'gios_station_id' => null,
        'station_name'    => null,
        'sensors'         => [
            'pm10' => null,
            'pm25' => null,
        ],
        'ignored_sensors' => [],
        'last_verified'   => '2026-10-07',
    ],
    'tarnowskie-gory' => [
        'slug'            => 'tarnowskie-gory',
        'label'           => 'Tarnowskie Góry',
        'lat'             => 50.4444,
        'lon'             => 18.8557,
        'teryt'           => '2413',
        'teryt_level'     => 'county',
        'teryt_name'      => 'powiatu tarnogórskiego',
        'has_gios'        => false, // stacja 839 nie raportuje bieżących pomiarów
        'gios_station_id' => 839,
        'station_name'    => 'Tarnowskie Góry (nieaktywna)',
        'sensors'         => [
            'pm10' => null,
            'pm25' => null,
        ],
        'ignored_sensors' => [],
        'last_verified'   => '2026-10-07',
    ],
    'knurow' => [
        'slug'            => 'knurow',
        'label'           => 'Knurów',
        'lat'             => 50.2208,
        'lon'             => 18.6747,
        'teryt'           => '2405',
        'teryt_level'     => 'county',
        'teryt_name'      => 'powiatu gliwickiego',
        'has_gios'        => false, // stacja 818 nie raportuje
        'gios_station_id' => 818,
        'station_name'    => 'Knurów (nieaktywna)',
        'sensors'         => [
            'pm10' => null,
            'pm25' => null,
        ],
        'ignored_sensors' => [],
        'last_verified'   => '2026-10-07',
    ],
    'bedzin' => [
        'slug'            => 'bedzin',
        'label'           => 'Będzin',
        'lat'             => 50.3259,
        'lon'             => 19.1297,
        'teryt'           => '2401',
        'teryt_level'     => 'county',
        'teryt_name'      => 'powiatu będzińskiego',
        'has_gios'        => false,
        'gios_station_id' => null,
        'station_name'    => null,
        'sensors'         => [
            'pm10' => null,
            'pm25' => null,
        ],
        'ignored_sensors' => [],
        'last_verified'   => '2026-10-07',
    ],
];
