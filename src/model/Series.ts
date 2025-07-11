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

import * as zrUtil from 'zrender/src/core/util';
import env from 'zrender/src/core/env';
import * as modelUtil from '../util/model';
import {
    DataHost, DimensionName, StageHandlerProgressParams,
    SeriesOption, ZRColor, BoxLayoutOptionMixin,
    ScaleDataValue,
    Dictionary,
    OptionDataItemObject,
    SeriesDataType,
    SeriesEncodeOptionMixin,
    OptionEncodeValue,
    ColorBy,
    StatesOptionMixin,
    DimensionLoose
} from '../util/types';
import ComponentModel, { ComponentModelConstructor } from './Component';
import {PaletteMixin} from './mixin/palette';
import { DataFormatMixin } from '../model/mixin/dataFormat';
import Model from '../model/Model';
import {
    getLayoutParams,
    mergeLayoutParam,
    fetchLayoutMode
} from '../util/layout';
import {createTask} from '../core/task';
import GlobalModel from './Global';
import { CoordinateSystem } from '../coord/CoordinateSystem';
import { ExtendableConstructor, mountExtend, Constructor } from '../util/clazz';
import { PipelineContext, SeriesTaskContext, GeneralTask, OverallTask, SeriesTask } from '../core/Scheduler';
import LegendVisualProvider from '../visual/LegendVisualProvider';
import SeriesData from '../data/SeriesData';
import Axis from '../coord/Axis';
import type { BrushCommonSelectorsForSeries, BrushSelectableArea } from '../component/brush/selector';
import makeStyleMapper from './mixin/makeStyleMapper';
import { SourceManager } from '../data/helper/sourceManager';
import { Source } from '../data/Source';
import { defaultSeriesFormatTooltip } from '../component/tooltip/seriesFormatTooltip';
import {ECSymbol} from '../util/symbol';
import {Group} from '../util/graphic';
import {LegendIconParams} from '../component/legend/LegendModel';
import {dimPermutations} from '../component/marker/MarkAreaView';

const inner = modelUtil.makeInner<{
    data: SeriesData
    dataBeforeProcessed: SeriesData
    sourceManager: SourceManager
}, SeriesModel>();

function getSelectionKey(data: SeriesData, dataIndex: number): string {
    return data.getName(dataIndex) || data.getId(dataIndex);
}

export const SERIES_UNIVERSAL_TRANSITION_PROP = '__universalTransitionEnabled';

interface SeriesModel {
    /**
     * Convenient for override in extended class.
     * Implement it if needed.
     */
    preventIncremental(): boolean;
    /**
     * See tooltip.
     * Implement it if needed.
     * @return Point of tooltip. null/undefined can be returned.
     */
    getTooltipPosition(dataIndex: number): number[];

    /**
     * Get data indices for show tooltip content. See tooltip.
     * Implement it if needed.
     */
    getAxisTooltipData(
        dim: DimensionName[],
        value: ScaleDataValue,
        baseAxis: Axis
    ): {
        dataIndices: number[],
        nestestValue: any
    };

    /**
     * Get position for marker
     */
    getMarkerPosition(
        value: ScaleDataValue[],
        dims?: typeof dimPermutations[number],
        startingAtTick?: boolean
    ): number[];

    /**
     * Get legend icon symbol according to each series type
     */
    getLegendIcon(opt: LegendIconParams): ECSymbol | Group;

    /**
     * See `component/brush/selector.js`
     * Defined the brush selector for this series.
     */
    brushSelector(
        dataIndex: number,
        data: SeriesData,
        selectors: BrushCommonSelectorsForSeries,
        area: BrushSelectableArea
    ): boolean;

    enableAriaDecal(): void;
}

class SeriesModel<Opt extends SeriesOption = SeriesOption> extends ComponentModel<Opt> {

    // [Caution]: Because this class or desecendants can be used as `XXX.extend(subProto)`,
    // the class members must not be initialized in constructor or declaration place.
    // Otherwise there is bad case:
    //   class A {xxx = 1;}
    //   enableClassExtend(A);
    //   class B extends A {}
    //   var C = B.extend({xxx: 5});
    //   var c = new C();
    //   console.log(c.xxx); // expect 5 but always 1.

    // @readonly
    type: string;

    // Should be impleneted in subclass.
    defaultOption: SeriesOption;

    // @readonly
    seriesIndex: number;

    // Will be injected.
    // @see `injectCoordinateSystem`
    coordinateSystem: CoordinateSystem;

    // Injected outside
    dataTask: SeriesTask;
    // Injected outside
    pipelineContext: PipelineContext;

    // ---------------------------------------
    // Props to tell visual/style.ts about how to do visual encoding.
    // ---------------------------------------
    // legend visual provider to the legend component
    legendVisualProvider: LegendVisualProvider;

    // Access path of style for visual
    visualStyleAccessPath: string;
    // Which property is treated as main color. Which can get from the palette.
    visualDrawType: 'fill' | 'stroke';
    // Style mapping rules.
    visualStyleMapper: ReturnType<typeof makeStyleMapper>;
    // If ignore style on data. It's only for global visual/style.ts
    // Enabled when series it self will handle it.
    ignoreStyleOnData: boolean;
    // If do symbol visual encoding
    hasSymbolVisual: boolean;
    // Default symbol type.
    defaultSymbol: string;
    // Symbol provide to legend.
    legendIcon: string;

    // It will be set temporary when cross series transition setting is from setOption.
    // TODO if deprecate further?
    [SERIES_UNIVERSAL_TRANSITION_PROP]: boolean;

    // ---------------------------------------
    // Props about data selection
    // ---------------------------------------
    private _selectedDataIndicesMap: Dictionary<number> = {};
    readonly preventUsingHoverLayer: boolean;

    static protoInitialize = (function () {
        const proto = SeriesModel.prototype;
        proto.type = 'series.__base__';
        proto.seriesIndex = 0;
        proto.ignoreStyleOnData = false;
        proto.hasSymbolVisual = false;
        proto.defaultSymbol = 'circle';
        // Make sure the values can be accessed!
        proto.visualStyleAccessPath = 'itemStyle';
        proto.visualDrawType = 'fill';
    })();


    init(option: Opt, parentModel: Model, ecModel: GlobalModel) {

        this.seriesIndex = this.componentIndex;

        this.dataTask = createTask<SeriesTaskContext>({
            count: dataTaskCount,
            reset: dataTaskReset
        });
        this.dataTask.context = {model: this};

        this.mergeDefaultAndTheme(option, ecModel);

        const sourceManager = inner(this).sourceManager = new SourceManager(this);
        sourceManager.prepareSource();

        const data = this.getInitialData(option, ecModel);
        wrapData(data, this);
        this.dataTask.context.data = data;

        if (__DEV__) {
            zrUtil.assert(data, 'getInitialData returned invalid data.');
        }

        inner(this).dataBeforeProcessed = data;

        // If we reverse the order (make data firstly, and then make
        // dataBeforeProcessed by cloneShallow), cloneShallow will
        // cause data.graph.data !== data when using
        // module:echarts/data/Graph or module:echarts/data/Tree.
        // See module:echarts/data/helper/linkSeriesData

        // Theoretically, it is unreasonable to call `seriesModel.getData()` in the model
        // init or merge stage, because the data can be restored. So we do not `restoreData`
        // and `setData` here, which forbids calling `seriesModel.getData()` in this stage.
        // Call `seriesModel.getRawData()` instead.
        // this.restoreData();

        autoSeriesName(this);

        this._initSelectedMapFromData(data);
    }

    /**
     * Util for merge default and theme to option
     */
    mergeDefaultAndTheme(option: Opt, ecModel: GlobalModel): void {
        const layoutMode = fetchLayoutMode(this);
        const inputPositionParams = layoutMode
            ? getLayoutParams(option as BoxLayoutOptionMixin) : {};

        // Backward compat: using subType on theme.
        // But if name duplicate between series subType
        // (for example: parallel) add component mainType,
        // add suffix 'Series'.
        let themeSubType = this.subType;
        if ((ComponentModel as ComponentModelConstructor).hasClass(themeSubType)) {
            themeSubType += 'Series';
        }
        zrUtil.merge(
            option,
            ecModel.getTheme().get(this.subType)
        );
        zrUtil.merge(option, this.getDefaultOption());

        // Default label emphasis `show`
        modelUtil.defaultEmphasis(option, 'label', ['show']);

        this.fillDataTextStyle(option.data as ArrayLike<any>);

        if (layoutMode) {
            mergeLayoutParam(option as BoxLayoutOptionMixin, inputPositionParams, layoutMode);
        }
    }

    mergeOption(newSeriesOption: Opt, ecModel: GlobalModel) {
        // this.settingTask.dirty();

        newSeriesOption = zrUtil.merge(this.option, newSeriesOption, true);
        this.fillDataTextStyle(newSeriesOption.data as ArrayLike<any>);

        const layoutMode = fetchLayoutMode(this);
        if (layoutMode) {
            mergeLayoutParam(
                this.option as BoxLayoutOptionMixin,
                newSeriesOption as BoxLayoutOptionMixin,
                layoutMode
            );
        }

        const sourceManager = inner(this).sourceManager;
        sourceManager.dirty();
        sourceManager.prepareSource();

        const data = this.getInitialData(newSeriesOption, ecModel);
        wrapData(data, this);
        this.dataTask.dirty();
        this.dataTask.context.data = data;

        inner(this).dataBeforeProcessed = data;

        autoSeriesName(this);

        this._initSelectedMapFromData(data);
    }

    fillDataTextStyle(data: ArrayLike<any>): void {
        // Default data label emphasis `show`
        // FIXME Tree structure data ?
        // FIXME Performance ?
        if (data && !zrUtil.isTypedArray(data)) {
            const props = ['show'];
            for (let i = 0; i < data.length; i++) {
                if (data[i] && data[i].label) {
                    modelUtil.defaultEmphasis(data[i], 'label', props);
                }
            }
        }
    }

    /**
     * Init a data structure from data related option in series
     * Must be overridden.
     */
    getInitialData(option: Opt, ecModel: GlobalModel): SeriesData {
        return;
    }

    /**
     * Append data to list
     */
    appendData(params: {data: ArrayLike<any>}): void {
        // FIXME ???
        // (1) If data from dataset, forbidden append.
        // (2) support append data of dataset.
        const data = this.getRawData();
        data.appendData(params.data);
    }

    /**
     * Consider some method like `filter`, `map` need make new data,
     * We should make sure that `seriesModel.getData()` get correct
     * data in the stream procedure. So we fetch data from upstream
     * each time `task.perform` called.
     */
    getData(dataType?: SeriesDataType): SeriesData<this> {
        const task = getCurrentTask(this);
        if (task) {
            const data = task.context.data;
            return (dataType == null || !data.getLinkedData ? data : data.getLinkedData(dataType)) as SeriesData<this>;
        }
        else {
            // When series is not alive (that may happen when click toolbox
            // restore or setOption with not merge mode), series data may
            // be still need to judge animation or something when graphic
            // elements want to know whether fade out.
            return inner(this).data as SeriesData<this>;
        }
    }

    getAllData(): ({
        data: SeriesData,
        type?: SeriesDataType
    })[] {
        const mainData = this.getData();
        return (mainData && mainData.getLinkedDataAll)
            ? mainData.getLinkedDataAll()
            : [{ data: mainData }];
    }

    setData(data: SeriesData): void {
        const task = getCurrentTask(this);
        if (task) {
            const context = task.context;
            // Consider case: filter, data sample.
            // FIXME:TS never used, so comment it
            // if (context.data !== data && task.modifyOutputEnd) {
            //     task.setOutputEnd(data.count());
            // }
            context.outputData = data;
            // Caution: setData should update context.data,
            // Because getData may be called multiply in a
            // single stage and expect to get the data just
            // set. (For example, AxisProxy, x y both call
            // getData and setDate sequentially).
            // So the context.data should be fetched from
            // upstream each time when a stage starts to be
            // performed.
            if (task !== this.dataTask) {
                context.data = data;
            }
        }
        inner(this).data = data;
    }

    getEncode() {
        const encode = (this as Model<SeriesEncodeOptionMixin>).get('encode', true);
        if (encode) {
            return zrUtil.createHashMap<OptionEncodeValue, DimensionName>(encode);
        }
    }

    getSourceManager(): SourceManager {
        return inner(this).sourceManager;
    }

    getSource(): Source {
        return this.getSourceManager().getSource();
    }

    /**
     * Get data before processed
     */
    getRawData(): SeriesData {
        return inner(this).dataBeforeProcessed;
    }

    getColorBy(): ColorBy {
        const colorBy = this.get('colorBy');
        return colorBy || 'series';
    }

    isColorBySeries(): boolean {
        return this.getColorBy() === 'series';
    }

    /**
     * Get base axis if has coordinate system and has axis.
     * By default use coordSys.getBaseAxis();
     * Can be overridden for some chart.
     * @return {type} description
     */
    getBaseAxis(): Axis {
        const coordSys = this.coordinateSystem;
        // @ts-ignore
        return coordSys && coordSys.getBaseAxis && coordSys.getBaseAxis();
    }

    /**
     * Retrieve the index of nearest value in the view coordinate.
     * Data position is compared with each axis's dataToCoord.
     *
     * @param axisDim axis dimension
     * @param dim data dimension
     * @param value
     * @param [maxDistance=Infinity] The maximum distance in view coordinate space
     * @return If and only if multiple indices has
     *         the same value, they are put to the result.
     */
    indicesOfNearest(axisDim: DimensionName, dim: DimensionLoose, value: number, maxDistance?: number): number[] {
        const data = this.getData();
        const coordSys = this.coordinateSystem;
        const axis = coordSys && coordSys.getAxis(axisDim);
        if (!coordSys || !axis) {
            return [];
        }
        const targetCoord = axis.dataToCoord(value);

        if (maxDistance == null) {
            maxDistance = Infinity;
        }

        const nearestIndices: number[] = [];
        let minDist = Infinity;
        let minDiff = -1;
        let nearestIndicesLen = 0;

        data.each(dim, (dimValue, idx) => {
            const dataCoord = axis.dataToCoord(dimValue);
            const diff = targetCoord - dataCoord;
            const dist = Math.abs(diff);
            if (dist <= maxDistance) {
                // When the `value` is at the middle of `this.get(dim, i)` and `this.get(dim, i+1)`,
                // we'd better not push both of them to `nearestIndices`, otherwise it is easy to
                // get more than one item in `nearestIndices` (more specifically, in `tooltip`).
                // So we choose the one that `diff >= 0` in this case.
                // But if `this.get(dim, i)` and `this.get(dim, j)` get the same value, both of them
                // should be push to `nearestIndices`.
                if (dist < minDist
                    || (dist === minDist && diff >= 0 && minDiff < 0)
                ) {
                    minDist = dist;
                    minDiff = diff;
                    nearestIndicesLen = 0;
                }
                if (diff === minDiff) {
                    nearestIndices[nearestIndicesLen++] = idx;
                }
            }
        });
        nearestIndices.length = nearestIndicesLen;
        return nearestIndices;
    }

    /**
     * Default tooltip formatter
     *
     * @param dataIndex
     * @param multipleSeries
     * @param dataType
     * @param renderMode valid values: 'html'(by default) and 'richText'.
     *        'html' is used for rendering tooltip in extra DOM form, and the result
     *        string is used as DOM HTML content.
     *        'richText' is used for rendering tooltip in rich text form, for those where
     *        DOM operation is not supported.
     * @return formatted tooltip with `html` and `markers`
     *        Notice: The override method can also return string
     */
    formatTooltip(
        dataIndex: number,
        multipleSeries?: boolean,
        dataType?: SeriesDataType
    ): ReturnType<DataFormatMixin['formatTooltip']> {
        return defaultSeriesFormatTooltip({
            series: this,
            dataIndex: dataIndex,
            multipleSeries: multipleSeries
        });
    }

    isAnimationEnabled(): boolean {
        const ecModel = this.ecModel;
        // Disable animation if using echarts in node but not give ssr flag.
        // In ssr mode, renderToString will generate svg with css animation.
        if (env.node && !(ecModel && ecModel.ssr)) {
            return false;
        }
        let animationEnabled = this.getShallow('animation');
        if (animationEnabled) {
            if (this.getData().count() > this.getShallow('animationThreshold')) {
                animationEnabled = false;
            }
        }
        return !!animationEnabled;
    }

    restoreData() {
        this.dataTask.dirty();
    }

    getColorFromPalette(name: string, scope: any, requestColorNum?: number): ZRColor {
        const ecModel = this.ecModel;
        // PENDING
        let color = PaletteMixin.prototype.getColorFromPalette.call(this, name, scope, requestColorNum);
        if (!color) {
            color = ecModel.getColorFromPalette(name, scope, requestColorNum);
        }
        return color;
    }

    /**
     * Use `data.mapDimensionsAll(coordDim)` instead.
     * @deprecated
     */
    coordDimToDataDim(coordDim: DimensionName): DimensionName[] {
        return this.getRawData().mapDimensionsAll(coordDim);
    }

    /**
     * Get progressive rendering count each step
     */
    getProgressive(): number | false {
        return this.get('progressive');
    }

    /**
     * Get progressive rendering count each step
     */
    getProgressiveThreshold(): number {
        return this.get('progressiveThreshold');
    }

    // PENGING If selectedMode is null ?
    select(innerDataIndices: number[], dataType?: SeriesDataType): void {
        this._innerSelect(this.getData(dataType), innerDataIndices);
    }

    unselect(innerDataIndices: number[], dataType?: SeriesDataType): void {
        const selectedMap = this.option.selectedMap;
        if (!selectedMap) {
            return;
        }
        const selectedMode = this.option.selectedMode;

        const data = this.getData(dataType);
        if (selectedMode === 'series' || selectedMap === 'all') {
            this.option.selectedMap = {};
            this._selectedDataIndicesMap = {};
            return;
        }

        for (let i = 0; i < innerDataIndices.length; i++) {
            const dataIndex = innerDataIndices[i];
            const nameOrId = getSelectionKey(data, dataIndex);
            selectedMap[nameOrId] = false;
            this._selectedDataIndicesMap[nameOrId] = -1;
        }
    }

    toggleSelect(innerDataIndices: number[], dataType?: SeriesDataType): void {
        const tmpArr: number[] = [];
        for (let i = 0; i < innerDataIndices.length; i++) {
            tmpArr[0] = innerDataIndices[i];
            this.isSelected(innerDataIndices[i], dataType)
                ? this.unselect(tmpArr, dataType)
                : this.select(tmpArr, dataType);
        }
    }

    getSelectedDataIndices(): number[] {
        if (this.option.selectedMap === 'all') {
            return [].slice.call(this.getData().getIndices());
        }
        const selectedDataIndicesMap = this._selectedDataIndicesMap;
        const nameOrIds = zrUtil.keys(selectedDataIndicesMap);
        const dataIndices = [];
        for (let i = 0; i < nameOrIds.length; i++) {
            const dataIndex = selectedDataIndicesMap[nameOrIds[i]];
            if (dataIndex >= 0) {
                dataIndices.push(dataIndex);
            }
        }
        return dataIndices;
    }

    isSelected(dataIndex: number, dataType?: SeriesDataType): boolean {
        const selectedMap = this.option.selectedMap;
        if (!selectedMap) {
            return false;
        }

        const data = this.getData(dataType);

        return (selectedMap === 'all' || selectedMap[getSelectionKey(data, dataIndex)])
            && !data.getItemModel<StatesOptionMixin<unknown, unknown>>(dataIndex).get(['select', 'disabled']);
    }

    isUniversalTransitionEnabled(): boolean {
        if (this[SERIES_UNIVERSAL_TRANSITION_PROP]) {
            return true;
        }

        const universalTransitionOpt = this.option.universalTransition;
        // Quick reject
        if (!universalTransitionOpt) {
            return false;
        }

        if (universalTransitionOpt === true) {
            return true;
        }

        // Can be simply 'universalTransition: true'
        return universalTransitionOpt && universalTransitionOpt.enabled;
    }

    private _innerSelect(data: SeriesData, innerDataIndices: number[]) {
        const option = this.option;
        const selectedMode = option.selectedMode;
        const len = innerDataIndices.length;
        if (!selectedMode || !len) {
            return;
        }

        if (selectedMode === 'series') {
            option.selectedMap = 'all';
        }
        else if (selectedMode === 'multiple') {
            if (!zrUtil.isObject(option.selectedMap)) {
                option.selectedMap = {};
            }
            const selectedMap = option.selectedMap;
            for (let i = 0; i < len; i++) {
                const dataIndex = innerDataIndices[i];
                // TODO different types of data share same object.
                const nameOrId = getSelectionKey(data, dataIndex);
                selectedMap[nameOrId] = true;
                this._selectedDataIndicesMap[nameOrId] = data.getRawIndex(dataIndex);
            }
        }
        else if (selectedMode === 'single' || selectedMode === true) {
            const lastDataIndex = innerDataIndices[len - 1];
            const nameOrId = getSelectionKey(data, lastDataIndex);
            option.selectedMap = {
                [nameOrId]: true
            };
            this._selectedDataIndicesMap = {
                [nameOrId]: data.getRawIndex(lastDataIndex)
            };
        }
    }

    private _initSelectedMapFromData(data: SeriesData) {
        // Ignore select info in data if selectedMap exists.
        // NOTE It's only for legacy usage. edge data is not supported.
        if (this.option.selectedMap) {
            return;
        }

        const dataIndices: number[] = [];
        if (data.hasItemOption) {
            data.each(function (idx) {
                const rawItem = data.getRawDataItem(idx);
                if (rawItem && (rawItem as OptionDataItemObject<unknown>).selected) {
                    dataIndices.push(idx);
                }
            });
        }

        if (dataIndices.length > 0) {
            this._innerSelect(data, dataIndices);
        }
    }

    // /**
    //  * @see {module:echarts/stream/Scheduler}
    //  */
    // abstract pipeTask: null

    static registerClass(clz: Constructor): Constructor {
        return ComponentModel.registerClass(clz);
    }
}

interface SeriesModel<Opt extends SeriesOption = SeriesOption>
    extends DataFormatMixin, PaletteMixin<Opt>, DataHost {

    // methods that can be implemented optionally to provide to components
    /**
     * Get dimension to render shadow in dataZoom component
     */
    getShadowDim?(): string
}
zrUtil.mixin(SeriesModel, DataFormatMixin);
zrUtil.mixin(SeriesModel, PaletteMixin);

export type SeriesModelConstructor = typeof SeriesModel & ExtendableConstructor;
mountExtend(SeriesModel, ComponentModel as SeriesModelConstructor);


/**
 * MUST be called after `prepareSource` called
 * Here we need to make auto series, especially for auto legend. But we
 * do not modify series.name in option to avoid side effects.
 */
function autoSeriesName(seriesModel: SeriesModel): void {
    // User specified name has higher priority, otherwise it may cause
    // series can not be queried unexpectedly.
    const name = seriesModel.name;
    if (!modelUtil.isNameSpecified(seriesModel)) {
        seriesModel.name = getSeriesAutoName(seriesModel) || name;
    }
}

function getSeriesAutoName(seriesModel: SeriesModel): string {
    const data = seriesModel.getRawData();
    const dataDims = data.mapDimensionsAll('seriesName');
    const nameArr: string[] = [];
    zrUtil.each(dataDims, function (dataDim) {
        const dimInfo = data.getDimensionInfo(dataDim);
        dimInfo.displayName && nameArr.push(dimInfo.displayName);
    });
    return nameArr.join(' ');
}

function dataTaskCount(context: SeriesTaskContext): number {
    return context.model.getRawData().count();
}

function dataTaskReset(context: SeriesTaskContext) {
    const seriesModel = context.model;
    seriesModel.setData(seriesModel.getRawData().cloneShallow());
    return dataTaskProgress;
}

function dataTaskProgress(param: StageHandlerProgressParams, context: SeriesTaskContext): void {
    // Avoid repeat cloneShallow when data just created in reset.
    if (context.outputData && param.end > context.outputData.count()) {
        context.model.getRawData().cloneShallow(context.outputData);
    }
}

// TODO refactor
function wrapData(data: SeriesData, seriesModel: SeriesModel): void {
    zrUtil.each(zrUtil.concatArray(data.CHANGABLE_METHODS, data.DOWNSAMPLE_METHODS), function (methodName) {
        data.wrapMethod(methodName as any, zrUtil.curry(onDataChange, seriesModel));
    });
}

function onDataChange(this: SeriesData, seriesModel: SeriesModel, newList: SeriesData): SeriesData {
    const task = getCurrentTask(seriesModel);
    if (task) {
        // Consider case: filter, selectRange
        task.setOutputEnd((newList || this).count());
    }
    return newList;
}

function getCurrentTask(seriesModel: SeriesModel): GeneralTask {
    const scheduler = (seriesModel.ecModel || {}).scheduler;
    const pipeline = scheduler && scheduler.getPipeline(seriesModel.uid);

    if (pipeline) {
        // When pipline finished, the currrentTask keep the last
        // task (renderTask).
        let task = pipeline.currentTask;
        if (task) {
            const agentStubMap = (task as OverallTask).agentStubMap;
            if (agentStubMap) {
                task = agentStubMap.get(seriesModel.uid);
            }
        }
        return task;
    }
}


export default SeriesModel;
