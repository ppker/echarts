/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/

/**
 * @file Visual mapping.
 */

import * as zrUtil from 'zrender/src/core/util';
import tokens from './tokens';

const visualDefault = {
    /**
     * @public
     */
    get: function (visualType: string, key: 'active' | 'inactive', isCategory?: boolean) {
        const value = zrUtil.clone(
            (defaultOption[visualType] || {})[key]
        );

        return isCategory
            ? (zrUtil.isArray(value) ? value[value.length - 1] : value)
            : value;
    }
};

const defaultOption: {[key: string]: {
    active: string[] | number[]
    inactive: string[] | number[]
}} = {

    color: {
        active: ['#006edd', '#e0ffff'],
        inactive: [tokens.color.transparent]
    },

    colorHue: {
        active: [0, 360],
        inactive: [0, 0]
    },

    colorSaturation: {
        active: [0.3, 1],
        inactive: [0, 0]
    },

    colorLightness: {
        active: [0.9, 0.5],
        inactive: [0, 0]
    },

    colorAlpha: {
        active: [0.3, 1],
        inactive: [0, 0]
    },

    opacity: {
        active: [0.3, 1],
        inactive: [0, 0]
    },

    symbol: {
        active: ['circle', 'roundRect', 'diamond'],
        inactive: ['none']
    },

    symbolSize: {
        active: [10, 50],
        inactive: [0, 0]
    }
};

export default visualDefault;
